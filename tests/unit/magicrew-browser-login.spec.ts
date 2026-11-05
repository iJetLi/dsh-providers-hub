/**
 * magicrew-browser-login.spec.ts —— 超级麦吉**网页版登录**单测
 *
 * 被测源码：`src/magicrew-browser-login.ts` + `MagicrewAuth.loginViaBrowser` +
 * `MagicrewService.loginViaBrowser` + `account.create` 的 `mode: 'browser'` 三步式。
 *
 * ── ⚠️⚠️ 硬约束：**绝不真起浏览器** ──────────────────────────────────────
 * 真起浏览器会在用户桌面**弹出可见窗口**（本仓库已记过两次真实污染：`example.invalid`
 * 与 `auth.huaweicloud.com/stub`）。⇒ 全部用例只走注入：
 * - `sessionFactory` —— 假会话（`waitForCredential` 由用例控制第几拍返回什么）；
 * - `MagicrewAuthOptions.browserLoginFactory` —— 假会话工厂；
 * - `fetchImpl` —— 假 fetch（签发 `mgw_` key 那一步，**永远不打** `i-magic-service`）。
 *
 * ⚠️ 唯一「走到真 `createChromiumMagicrewLogin`」的用例是**找不到浏览器**那条：
 * 它注入 `resolveBrowser: () => undefined` ⇒ 在 `spawn` **之前**就抛错，零进程、
 * 零窗口。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { BrowserDeploymentError } from '../../src/chromium-session.js'
import {
  MAGICREW_BROWSER_LOGIN_POLL_MS,
  MAGICREW_BROWSER_LOGIN_TIMEOUT_MS,
  createChromiumMagicrewLogin,
  createMagicrewCredentialWaiter,
  ensureMagicrewLoginPage,
  createProfileCredentialReader,
  isBlankPageUrl,
  readCredentialViaCdp,
  readCredentialViaCdpDetailed,
  startMagicrewBrowserLogin,
  type MagicrewBrowserLogin,
} from '../../src/magicrew-browser-login.js'
import { MagicrewAuth, type MagicrewCredential } from '../../src/magicrew-auth.js'
import { MAGICREW, MAGICREW_GATEWAY_TOKENS_PATH, MAGICREW_INTL, type MagicrewProduct } from '../../src/magicrew-product.js'
import { MAGICREW_PROFILE_PATH, type MagicrewProfile } from '../../src/magicrew-profile.js'
import { MagicrewService } from '../../src/magicrew.js'

// ════════════════════════════════════════════════════════════════════════
// fixture 原语
// ════════════════════════════════════════════════════════════════════════

/** 固定时钟：所有判据都不依赖真实时间（否则用例是日期炸弹）。 */
const NOW = 1_800_000_000_000

const ORIGIN_CN = 'https://www.letsmagic.cn'

/** 造一把形状合法的 JWT（只关心 `iat` / `exp`，签名段是假的）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fixture-signature`
}

const JWT_LIVE = makeJwt({ iat: Math.floor(NOW / 1000) - 60, exp: Math.floor(NOW / 1000) + 3600 })

/** 一条 leveldb 记录的形态（与 `magicrew-local-browser.ts` 的读法一致）。 */
function storageEntry(origin: string, name: string, value: string): string {
  return `_${origin}\u0000\u0001${name}\u0000\u0001${value}`
}

function credentialPair(jwt: string, organizationCode: string): string {
  return `{"key":"authorization","value":"${jwt}"}`
    + `{"key":"organizationCode","value":"${organizationCode}"}`
}

/** 造一个临时 User Data 目录，里面写一段 leveldb 文本（`Default` profile）。 */
function makeUserData(text: string, profile = 'Default'): string {
  const root = mkdtempSync(join(tmpdir(), 'magicrew-weblogin-fixture-'))
  const dir = join(root, profile, 'Local Storage', 'leveldb')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '000003.log'), Buffer.from(text, 'latin1'))
  return root
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 签发 `mgw_` key 的上游信封（`code:1000` = ok）。
 *
 * ⚠️ `withExpiry: false` = **真机凭据的那种形状**（只有 `api_key` / `refresh_token`，
 * 没有任何到期时刻）—— 卡片「有效期 未知」就是这一格；值走默认参数，避免在调用处
 * 再写一遍字面量（本仓 PII 守卫见 `magicrew-local-browser.spec.ts` 同款说明）。
 */
function keyEnvelope(
  apiKey = 'mgw_from-web-login',
  refreshToken = 'rt_from-web-login',
  withExpiry = true,
): Response {
  return jsonResponse({
    code: 1000,
    data: {
      api_key: apiKey,
      refresh_token: refreshToken,
      ...withExpiry ? {
        api_key_expires_at: NOW + 7200_000,
        refresh_token_expires_at: NOW + 7 * 86400_000,
      } : {},
    },
  })
}

/**
 * **假会话**：`waitForCredential` 由用例控制。
 *
 * ⚠️ 刻意实现成**第 N 拍返回**（而不是「立刻返回」）：本模块唯一有意思的逻辑就是
 * 「轮询到第几次拿到」，而立刻返回的假会话连那条循环都没走到。
 */
function fakeSession(script: {
  /** 依次返回的凭据（`undefined` = 这一拍还没读到）。 */
  results: readonly (MagicrewCredential | undefined)[]
  /** 每拍之间的等待（缺省 0 —— 用例不做真实等待）。 */
  onWait?: () => void
}): MagicrewBrowserLogin & { closeCalls: number, waits: number } {
  let index = 0
  const session = {
    closeCalls: 0,
    waits: 0,
    close(): void {
      session.closeCalls += 1
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async waitForCredential(_timeoutMs: number): Promise<MagicrewCredential | undefined> {
      session.waits += 1
      const value = script.results[Math.min(index, script.results.length - 1)]
      index += 1
      script.onWait?.()
      return value
    },
  }
  return session
}

/** 最小内存凭据库（形状与宿主 `ctx.credentials` 一致：**值是字符串**）。 */
class FakeStore {
  readonly values = new Map<string, string>()
  readonly setCalls: string[] = []

  async resolve(ref: { name?: unknown } | string): Promise<{ value: string } | undefined> {
    const value = this.values.get(refKey(ref))
    return value === undefined ? undefined : { value }
  }

  async set(ref: { name?: unknown } | string, value: string): Promise<void> {
    const key = refKey(ref)
    this.setCalls.push(key)
    this.values.set(key, value)
  }

  async unset(ref: { name?: unknown } | string): Promise<void> {
    this.values.delete(refKey(ref))
  }

  saved(refName: string): Record<string, unknown> | undefined {
    const raw = this.values.get(refName)
    return raw === undefined ? undefined : JSON.parse(raw) as Record<string, unknown>
  }
}

function refKey(ref: { name?: unknown } | string): string {
  if (typeof ref === 'string') return ref
  const name = ref?.name
  return typeof name === 'string' ? name : String(ref)
}

function makeContext(store: FakeStore): Context {
  const ctx = new Context()
  ctx.provide('credentials', store as never)
  return ctx
}

// ════════════════════════════════════════════════════════════════════════
// ① startMagicrewBrowserLogin：URL 与注入点
// ════════════════════════════════════════════════════════════════════════

describe('startMagicrewBrowserLogin', () => {
  it('★★ 打开的是 `webOrigin + /login`（不是裸域、更不是 product.host）', async () => {
    const seen: string[] = []
    const session = fakeSession({ results: [undefined] })
    await startMagicrewBrowserLogin({
      product: MAGICREW,
      sessionFactory: async (url) => {
        seen.push(url)
        return session
      },
    })

    // ⚠️ **两个都必须对**（2026-10-29 用户实测报障）：
    //   ① 裸 `webOrigin` 是**首页**、不是登录页 —— 用户在那页上找不到登录框；
    //   ② `product.host` 是 API 子域，localStorage 里根本没有那个 origin 的记录。
    expect(seen).toEqual([`${MAGICREW.webOrigin}/login`])
    // ⚠️ **不带邀请码**（用户 2026-10-29 明确要求）：`?invitation=` 会把新注册的号
    //    挂在别人的邀请码下。这条断言防的是「以后有人照参考实现加回作者码」。
    expect(seen[0]).not.toContain('invitation')
    // ⚠️ 这条断言是**防回退**的：写成 `product.host` 不会报错、只会永远等不到凭据
    //   （localStorage 里没有那个 origin 的记录），症状是「窗口打开了、登完没反应」。
    expect(seen[0]).not.toBe(MAGICREW.host)
    expect(new URL(MAGICREW.host).hostname).not.toBe(new URL(MAGICREW.webOrigin).hostname)
  })

  it('★ 注入的 sessionFactory 原样返回（不缓存、不改造）', async () => {
    const session = fakeSession({ results: [undefined] })
    const created = await startMagicrewBrowserLogin({ sessionFactory: async () => session })
    expect(created).toBe(session)
  })

  it('★ 缺省超时是 4 分钟（**早于**客户端 5 分钟的轮询上限，留一分钟把原因送到眼前）', () => {
    expect(MAGICREW_BROWSER_LOGIN_TIMEOUT_MS).toBe(240_000)
    expect(MAGICREW_BROWSER_LOGIN_TIMEOUT_MS).toBeLessThan(300_000)
    // 轮询间隔：不能是 0（会空转），且必须比客户端 1 秒一拍更密（凭据一出现就抓到）。
    expect(MAGICREW_BROWSER_LOGIN_POLL_MS).toBeGreaterThan(0)
    expect(MAGICREW_BROWSER_LOGIN_POLL_MS).toBeLessThanOrEqual(1_000)
  })

  it('★★ `log` 必须逐跳透传到等待循环（否则那行诊断**根本不会产生**）', () => {
    /**
     * ⚠️⚠️ 真机报障 2026-10-29 的直接教训：那行「CDP 与磁盘都没读到凭据」是下次
     * 报障时**唯一**能区分「用户没登」与「我们读的方式坏了」的东西。
     *
     * 链路有三跳，**任何一跳断了都是静默丢失**：
     * ① `magicrew-auth.ts` 的缺省 `browserLoginFactory` → `startMagicrewBrowserLogin({log})`
     * ② `startMagicrewBrowserLogin` → `createChromiumMagicrewLogin({log})`
     * ③ `createChromiumMagicrewLogin` → 等待循环的 deps（`...{ log: deps.log }`）
     *
     * ⚠️ **如实标注**：这三条是**源码级**断言（跳 ①② 的默认路径会真起浏览器，
     * 单测不许走；跳 ③ 的装配同样只在真会话里才跑到）。源码断言的固有弱点
     * （`if (false)` 短路禁用）在这里由 ③c 组的行为用例补上 —— 那一组真的
     * 调等待循环并断言 `log` 收到、且**内容三件套齐全**。⇒ 本用例只守「透传没被删掉」，
     * 不声称自己证明了运行时行为。
     */
    const here = dirname(fileURLToPath(import.meta.url))
    const loginSource = readFileSync(resolve(here, '../../src/magicrew-browser-login.ts'), 'utf8')
    const authSource = readFileSync(resolve(here, '../../src/magicrew-auth.ts'), 'utf8')

    // 跳 ②：`startMagicrewBrowserLogin` 把 `options.log` 交给 `createChromiumMagicrewLogin`。
    expect(loginSource).toMatch(/createChromiumMagicrewLogin\(target, \{[\s\S]{0,240}?log: options\.log/)
    // 跳 ③：`createChromiumMagicrewLogin` 把它放进会话的等待 deps（`new ChromiumProfileLogin`
    // 再 `...deps` 展开给 `createMagicrewCredentialWaiter`）。
    expect(loginSource).toMatch(/new ChromiumProfileLogin\([\s\S]{0,400}?log: deps\.log/)
    // ⚠️ 中间那一跳也不能丢：`ChromiumProfileLogin` 必须**原样展开** deps（含 `log`）。
    expect(loginSource).toMatch(/createMagicrewCredentialWaiter\(\{\s*\.\.\.deps,/)
    // 跳 ①：`magicrew-auth.ts` 的缺省工厂给出 `log` 出口（走 warn，不是无声的 info）。
    expect(authSource).toMatch(/startMagicrewBrowserLogin\(\{[\s\S]{0,800}?log: \(message\)/)
    expect(authSource).toMatch(/this\.warnImpl !== undefined\) this\.warnImpl\(message\)/)
  })
})

describe('ensureMagicrewLoginPage', () => {
  function fakeCdp(initialUrl: string, opts?: { pages?: Array<{ type?: string, targetId: string, url: string }>, navigateError?: string }) {
    const calls: { method: string, params: Record<string, unknown>, sessionId?: string }[] = []
    const cdp = {
      send: async (method: string, params: Record<string, unknown>, _timeout?: number, sessionId?: string) => {
        calls.push({ method, params, sessionId })
        if (method === 'Target.getTargets') {
          // ⚠️ **必须带 `type: 'page'`** —— 真实 CDP 的 `targetInfos[].type`
          //    是必填字段（实现侧按它过滤）。
          return {
            targetInfos: opts?.pages ?? [{ type: 'page', targetId: 'page-1', url: initialUrl }],
          }
        }
        if (method === 'Target.attachToTarget') return { sessionId: 'session-1' }
        if (method === 'Page.navigate') {
          return opts?.navigateError === undefined ? {} : { errorText: opts.navigateError }
        }
        return {}
      },
    }
    return { cdp, calls }
  }

  it('★★ CDP 就绪时仍是 about:blank ⇒ 主动导航到登录页，不能把空白窗交给用户', async () => {
    const { cdp, calls } = fakeCdp('about:blank')
    await ensureMagicrewLoginPage({ cdp }, `${ORIGIN_CN}/login`)
    expect(calls.find((call) => call.method === 'Page.navigate')).toMatchObject({
      params: { url: `${ORIGIN_CN}/login` },
      sessionId: 'session-1',
    })
    expect(calls.find((call) => call.method === 'Target.detachFromTarget')?.sessionId).toBeUndefined()
    expect(calls.at(-1)).toMatchObject({
      method: 'Target.detachFromTarget',
      params: { sessionId: 'session-1' },
    })
  })

  it('★ 已有麦吉页面 ⇒ 不重复导航', async () => {
    const { cdp, calls } = fakeCdp(`${ORIGIN_CN}/login`)
    await ensureMagicrewLoginPage({ cdp }, `${ORIGIN_CN}/login`)
    expect(calls.some((call) => call.method === 'Page.navigate')).toBe(false)
  })

  it('★★ `chrome://newtab/` 也算空白页 ⇒ 要导航（2026-10-30 审计 P1 D-05 修）', async () => {
    // ⚠️ 实测 `new URL('chrome://newtab/').hostname` = `'newtab'`（**非空**）⇒
    //    旧实现只认 `about:blank` ⇒ newtab 落到 `pages[0]` 兜底。
    const { cdp, calls } = fakeCdp('chrome://newtab/')
    await ensureMagicrewLoginPage({ cdp }, `${ORIGIN_CN}/login`)
    expect(calls.find((call) => call.method === 'Page.navigate')).toMatchObject({
      params: { url: `${ORIGIN_CN}/login` },
    })
  })

  it('★★ 空白页判据必须**前缀匹配**（2026-10-30 第二轮审计 P3-1 修）', () => {
    // ⚠️⚠️ 真机实测的空白页形态远不止三种 ⇒ 全等判据会漏掉它们 ⇒
    //    用户面对空白首屏、且插件不导航。
    for (const url of [
      'about:blank',
      'about:blank#x',
      'chrome://newtab/',
      'chrome://new-tab-page/',
      'chrome://new-tab-page-third-party/',
      'chrome://new-tab-page/?foo=1',
      'chrome-search://local-ntp/http://newtab/',
      'edge://newtab/',
    ]) {
      expect(isBlankPageUrl(url), `${url} 必须算空白页`).toBe(true)
    }
    // ⚠️ 反向对照：**真实页面**不得被当成空白页（否则会抢用户的标签页）
    for (const url of [
      'https://www.letsmagic.cn/login',
      'https://example.com/somewhere',
      'chrome://version/',
      'chrome://settings/',
    ]) {
      expect(isBlankPageUrl(url), `${url} 不得算空白页`).toBe(false)
    }
  })

  it('★★ **不得**抢走用户正在看的标签页（2026-10-30 审计 P1 D-05 修）', async () => {
    // ⚠️ 旧实现是 `pages.find(about:blank) ?? pages[0]` ⇒ **没有空白页时**
    //    它会导航 `pages[0]`（用户正在看的页面！）⇒ 用户的标签页被冲掉。
    // ⇒ 现在：**只**导航空白页；没有空白页就**不导航**。
    const { cdp, calls } = fakeCdp('https://example.com/somewhere', {
      pages: [
        { type: 'page', targetId: 'user-page', url: 'https://example.com/somewhere' },
        { type: 'page', targetId: 'blank-page', url: 'about:blank' },
      ] as Array<{ type: string, targetId: string, url: string }>,
    })
    await ensureMagicrewLoginPage({ cdp }, `${ORIGIN_CN}/login`)
    // ⚠️ 导航的必须是**空白页**，不是用户的页面
    expect(calls.find((call) => call.method === 'Target.attachToTarget')?.params.targetId)
      .toBe('blank-page')
  })

  it('★★ 没有空白页 ⇒ **不导航**（不抢用户标签页）', async () => {
    const { cdp, calls } = fakeCdp('https://example.com/somewhere', {
      pages: [
        { type: 'page', targetId: 'user-page', url: 'https://example.com/somewhere' },
      ] as Array<{ type: string, targetId: string, url: string }>,
    })
    await ensureMagicrewLoginPage({ cdp }, `${ORIGIN_CN}/login`)
    expect(calls.some((call) => call.method === 'Page.navigate')).toBe(false)
    expect(calls.some((call) => call.method === 'Target.attachToTarget')).toBe(false)
  })

  it('★★ 导航失败**不抛**（2026-10-30 审计 P1 D-06 修：窗口还开着，用户可自己登录）', async () => {
    // ⚠️ 旧实现抛错 ⇒ 冒泡 ⇒ `failLogin` ⇒ **占位账号被删**。
    const { cdp } = fakeCdp('about:blank', { navigateError: 'net::ERR_NAME_NOT_RESOLVED' })
    const logs: string[] = []
    await expect(ensureMagicrewLoginPage({ cdp }, `${ORIGIN_CN}/login`, (m) => logs.push(m)))
      .resolves.toBeUndefined()
    // ⚠️ 失败要**留痕**（否则用户与下次报障都看不到线索）
    expect(logs.join('\n')).toContain('net::ERR_NAME_NOT_RESOLVED')
  })

  it('★ `Target.getTargets` 抛错 ⇒ **不抛**（同上一条）', async () => {
    const cdp = {
      send: async (method: string): Promise<unknown> => {
        if (method === 'Target.getTargets') throw new Error('CDP Target.getTargets 超时（3000ms）')
        return {}
      },
    }
    await expect(ensureMagicrewLoginPage({ cdp }, `${ORIGIN_CN}/login`)).resolves.toBeUndefined()
  })

  it('★ `cdp === undefined` 仍**抛**（通道压根没就绪 ⇒ 连窗口都不成立）', async () => {
    await expect(ensureMagicrewLoginPage({ cdp: undefined }, `${ORIGIN_CN}/login`))
      .rejects.toThrow(/调试通道未就绪/)
  })

  it('★★ **接线点**必须真的调用 `ensureMagicrewLoginPage`（2026-10-30 审计 M10 修）', () => {
    // ⚠️⚠️ 旧守卫只测**函数本身**，**不测接线** ⇒ 变异「删掉
    //    `createChromiumMagicrewLogin` 里那一行调用」⇒ **69 条全绿** ⇒
    //    「about:blank ⇒ 主动导航」这条核心声称在**接线上零保护**。
    // ⇒ 这里守**源码接线点**（真起浏览器不许 ⇒ 只能源码级）。
    //
    // ⚠️⚠️ 源码级断言的已知弱点是 `if (false)` 短路禁用 ⇒ 下面**额外**断言
    //    「调用点不在任何假分支里」。
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../../src/magicrew-browser-login.ts'), 'utf8')
    // ⚠️ 断言：**调用点**（`await (…)`）在 `session.start()` 之后的 try 块里。
    //    ⚠️ 必须匹配「调用形态」而不是函数名 —— 匹配函数名会命中
    //    `deps.ensureLoginPage?: typeof ensureMagicrewLoginPage` 这类**类型标注**
    //    ⇒ 变异「删掉调用点」仍然全绿（**假绿**，本轮实测踩到）。
    expect(source).toMatch(/await session\.start\(\)[\s\S]{0,800}?await \(deps\.ensureLoginPage/)
    // ⚠️ 反向对照：**不得**有 `if (false)` 之类的死分支包住它。
    expect(source).not.toMatch(/if \(false\)[\s\S]{0,200}?ensureMagicrewLoginPage/)
  })

  it('★★ 导航失败**不得**冒泡 ⇒ 不得触发「删占位账号」（2026-10-30 第二轮审计 P2 修）', async () => {
    // ⚠️⚠️ 上一版守卫**只在函数层**（`ensureMagicrewLoginPage` 自己不抛）⇒
    //    变异「删掉接线点的兜底 try」或「catch 改成 rethrow」⇒ **76 条全绿**
    //    ⇒ 第一轮 P1「删占位账号」缺陷**可无声复活**。
    //
    // ⇒ 这里守**接线级因果链**：注入一个**抛错的** `ensureLoginPage`
    //    ⇒ 断言 `createChromiumMagicrewLogin` **不抛**、且 **dispose 未被调用**
    //    （dispose 会关窗 ⇒ 用户连手动登录的机会都没有）。
    const logs: string[] = []
    let disposed = 0
    const fakeSession = {
      start: async () => {},
      dispose: () => { disposed += 1 },
      userDataDir: undefined,
      waitForCredential: async () => undefined,
      close: () => {},
    } as unknown as Parameters<typeof createChromiumMagicrewLogin>[1] & object
    const created = await createChromiumMagicrewLogin(ORIGIN_CN, {
      sessionFactory: async () => fakeSession,
      ensureLoginPage: async () => { throw new Error('导航炸了') },
      log: (m) => logs.push(m),
    } as never)
    expect(created, '导航失败不得冒泡（否则 RPC 层 failLogin 会删占位账号）').toBeDefined()
    expect(disposed, '导航失败**不得**关窗（用户还要手动登录）').toBe(0)
    expect(logs.join('\n')).toContain('导航炸了')
  })
})

// ════════════════════════════════════════════════════════════════════════
// ② createMagicrewCredentialWaiter：轮询语义（零真实等待）
// ════════════════════════════════════════════════════════════════════════

describe('createMagicrewCredentialWaiter', () => {
  /** 可控时钟 + 可控 sleep（`sleep` 推进时钟 ⇒ 无需真实等待）。 */
  function clock() {
    let time = NOW
    const waits: number[] = []
    return {
      now: () => time,
      sleep: async (ms: number) => {
        waits.push(ms)
        time += ms
      },
      waits,
      get time() { return time },
    }
  }

  it('★★ 第 3 次轮询才读到 ⇒ 返回它（前两次 `undefined` 不算超时）', async () => {
    const clk = clock()
    const credential: MagicrewCredential = { jwt: JWT_LIVE, organizationCode: 'org-cn' }
    let reads = 0
    const wait = createMagicrewCredentialWaiter({
      read: () => {
        reads += 1
        return reads >= 3 ? credential : undefined
      },
      now: clk.now,
      sleep: clk.sleep,
    })

    expect(await wait(60_000)).toEqual(credential)
    // ⚠️ 正好 3 次读：少一次拿不到、多一次说明循环没有在拿到时立刻退出。
    expect(reads).toBe(3)
    expect(clk.waits, '中间两拍各睡一个完整间隔').toEqual([
      MAGICREW_BROWSER_LOGIN_POLL_MS,
      MAGICREW_BROWSER_LOGIN_POLL_MS,
    ])
  })

  it('★★ 一直读不到 ⇒ 到点返回 undefined（**不抛错**：这是正常路径）', async () => {
    const clk = clock()
    let reads = 0
    const wait = createMagicrewCredentialWaiter({
      read: () => { reads += 1; return undefined },
      now: clk.now,
      sleep: clk.sleep,
    })

    // ⚠️ **不吃 rejects**：这里刻意用 `await` 而不是 `expect(...).rejects` ——
    //    若实现改成抛错，这条会以「unexpected rejection」失败，判据是同一个。
    const result = await wait(5_000)
    expect(result).toBeUndefined()
    expect(clk.time, '不得越过 deadline 多睡一格').toBeLessThanOrEqual(NOW + 5_000)
    expect(reads, '每拍一次读，且到点即停').toBe(11) // 5000/500 + 起始那一拍
  })

  it('★ `timeoutMs = 0` 也给**一次**机会（「刚登完就超时」的边界不能判成没登录）', async () => {
    const credential: MagicrewCredential = { jwt: JWT_LIVE, organizationCode: 'org-cn' }
    let reads = 0
    const wait = createMagicrewCredentialWaiter({
      read: () => { reads += 1; return credential },
      now: () => NOW,
      sleep: async () => { throw new Error('不该睡：第一拍就读到了') },
    })
    expect(await wait(0)).toEqual(credential)
    expect(reads).toBe(1)
  })

  it('★ 读不到且 `timeoutMs = 0` ⇒ 立刻 undefined（零次 sleep）', async () => {
    const waits: number[] = []
    const wait = createMagicrewCredentialWaiter({
      read: () => undefined,
      now: () => NOW,
      sleep: async (ms) => { waits.push(ms) },
    })
    expect(await wait(0)).toBeUndefined()
    expect(waits).toEqual([])
  })

  it('★★ 已收窗 ⇒ 立刻 undefined（不必耗满预算）', async () => {
    const clk = clock()
    let stopped = false
    const wait = createMagicrewCredentialWaiter({
      read: () => undefined,
      now: clk.now,
      sleep: async (ms) => { clk.sleep(ms); stopped = true },
      isStopped: () => stopped,
    })
    expect(await wait(120_000)).toBeUndefined()
    // 第一拍没读到 + 拍间醒来时已收窗 ⇒ 只睡了一格（不是 240 格）。
    expect(clk.waits).toHaveLength(1)
  })

  it('★★ 凭据在「已收窗」那一刻才出现 ⇒ **仍然返回它**（读取先于停止判据）', async () => {
    /**
     * 真实形态：用户登完顺手关掉窗口 ⇒ 浏览器进程已退出（`isStopped` 真）而
     * localStorage 里已经有凭据。若先判停止再读，这次**已成功的登录**会被报成
     * `undefined` —— 用户看到「登录未完成」，实际他已登好。
     */
    const credential: MagicrewCredential = { jwt: JWT_LIVE, organizationCode: 'org-cn' }
    const wait = createMagicrewCredentialWaiter({
      read: () => credential,
      now: () => NOW,
      sleep: async () => { throw new Error('不该睡') },
      isStopped: () => true,
    })
    expect(await wait(120_000)).toEqual(credential)
  })
})

// ════════════════════════════════════════════════════════════════════════
// ③ createProfileCredentialReader：读的是**本次 profile**
// ════════════════════════════════════════════════════════════════════════

describe('createProfileCredentialReader', () => {
  it('★★ 从**注入的临时 profile** 里读（不是用户真实浏览器目录）', () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const read = createProfileCredentialReader(root, 'www.letsmagic.cn')
    expect(read()).toEqual({ jwt: JWT_LIVE, organizationCode: 'org-cn' })
  })

  it('★ 换一个空目录 ⇒ undefined（证明 roots 真的被传下去了、没有回落真实目录）', () => {
    const empty = mkdtempSync(join(tmpdir(), 'magicrew-weblogin-empty-'))
    const read = createProfileCredentialReader(empty, 'www.letsmagic.cn')
    expect(read()).toBeUndefined()
  })

  it('★ 目录为空串 ⇒ 立刻 undefined（不发任何文件系统调用）', () => {
    const readCreds = vi.fn()
    const read = createProfileCredentialReader('', 'www.letsmagic.cn', {
      readCreds: readCreds as never,
    })
    expect(read()).toBeUndefined()
    expect(readCreds).not.toHaveBeenCalled()
  })

  it('★ 读盘抛错 ⇒ undefined（**不**把「读不到」当成「没登录」而抛错）', () => {
    const read = createProfileCredentialReader('/whatever', 'www.letsmagic.cn', {
      readCreds: (() => { throw new Error('EACCES') }) as never,
    })
    expect(read()).toBeUndefined()
  })

  it('★ 只搬 jwt + organizationCode（`expiresAt` 不是 `MagicrewCredential` 的字段）', () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const credential = createProfileCredentialReader(root, 'www.letsmagic.cn')()
    expect(Object.keys(credential ?? {}).sort()).toEqual(['jwt', 'organizationCode'])
  })
})

// ════════════════════════════════════════════════════════════════════════
// ③b readCredentialViaCdp：**实时**读（主路径）
// ════════════════════════════════════════════════════════════════════════

/**
 * 假 CDP 通道：**记录调用序列**，并按 `handler` 应答。
 *
 * ⚠️ 绝不真连 CDP / 真起浏览器（见文件头硬约束）。这里之所以要记调用序列而不是只
 * 断言结果：本路径有三个**静默失效**点 —— 少一步 `flatten`、漏传 `sessionId`、
 * 拿全串等值做 URL 匹配。三者都会让 `Runtime.evaluate` 落空，而落空与「用户还没登完」
 * 在结果上**同形**（都回 `undefined`）⇒ 只断言结果的话这三种错法**全绿**。
 */
function fakeCdp(handler: (call: { method: string, params: Record<string, unknown> }) => unknown): {
  calls: { method: string, params: Record<string, unknown>, sessionId: string | undefined }[]
  session: { cdp: { send: (m: string, p?: Record<string, unknown>, t?: number, s?: string) => Promise<unknown> } }
  methods: () => string[]
} {
  const calls: { method: string, params: Record<string, unknown>, sessionId: string | undefined }[] = []
  const session = {
    cdp: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async send(
        method: string,
        params: Record<string, unknown> = {},
        _timeoutMs?: number,
        sessionId?: string,
      ): Promise<unknown> {
        calls.push({ method, params, sessionId })
        return handler({ method, params })
      },
    },
  }
  return { calls, session, methods: () => calls.map((call) => call.method) }
}

/** `Target.getTargets` 的应答：一个命中站点的 page target。 */
function targetsWith(url: string, targetId = 'TARGET-1'): unknown {
  return { targetInfos: [{ targetId, type: 'page', url }] }
}

/** `Runtime.evaluate` 的应答（页面里 `JSON.stringify({...})` 的产物）。 */
function evaluateWith(values: {
  authorization?: string | null
  organizationCode?: string | null
  teamshareOrganizationCode?: string | null
  length?: number
}): unknown {
  return {
    result: {
      value: JSON.stringify({
        a: values.authorization ?? null,
        o: values.organizationCode ?? null,
        t: values.teamshareOrganizationCode ?? null,
        n: values.length ?? 0,
      }),
    },
  }
}

/** 一条「已登录」的 evaluate 应答。 */
function loggedInEvaluate(organizationCode = 'org-fixture'): unknown {
  return evaluateWith({
    authorization: JWT_LIVE,
    organizationCode,
    length: 2,
  })
}

const LOGIN_PAGE = `${ORIGIN_CN}/login`

describe('readCredentialViaCdp（**实时**读，磁盘不落盘的真解）', () => {
  it('★★ 调用序列必须是 getTargets → attachToTarget{flatten:true} → evaluate{带 sessionId}', async () => {
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(LOGIN_PAGE)
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      if (method === 'Runtime.evaluate') return loggedInEvaluate()
      return {}
    })

    const found = await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn'])

    expect(found).toEqual({ jwt: JWT_LIVE, organizationCode: 'org-fixture' })
    // ⚠️ 前三步逐字钉住（顺序即语义）：
    expect(cdp.methods().slice(0, 3)).toEqual([
      'Target.getTargets',
      'Target.attachToTarget',
      'Runtime.evaluate',
    ])
    // ⚠️ `flatten: true` 少一个都会让 `sessionId` 用不了（非 flatten 模式的会话
    //    无法在**同一条** WebSocket 上复用，`Runtime.evaluate` 会回 -32601）。
    expect(cdp.calls[1]?.params).toEqual({ targetId: 'TARGET-1', flatten: true })
    // ⚠️ **页面级命令必须带 sessionId**：不带就落在浏览器端点上，回一句含糊的
    //    `-32601 'Runtime.evaluate' wasn't found`（看起来像「API 不存在」）。
    expect(cdp.calls[2]?.sessionId, 'Runtime.evaluate 必须带 sessionId').toBe('SESSION-1')
    // 取值表达式必须是**一次**取全（见源码注释：分四次读会开一个错配窗口）。
    const expression = String(cdp.calls[2]?.params.expression)
    expect(expression).toContain("localStorage.getItem('authorization')")
    expect(expression).toContain("localStorage.getItem('organizationCode')")
    expect(expression).toContain("localStorage.getItem('teamshareOrganizationCode')")
    expect(expression).toContain('localStorage.length')
    expect(cdp.calls[2]?.params.returnByValue, 'evaluate 必须 returnByValue').toBe(true)
  })

  it('★★ URL 用 **hostname** 匹配：登录后的真实形态必须命中', async () => {
    /**
     * ⚠️⚠️ 这是本任务最容易写错的一格：登录后地址**不是** `/login` 了，而是
     * `https://www.letsmagic.cn/global/super/workspace/<18 位数字>`（实测形态）。
     * 若用全串等值匹配，用户**登录成功那一秒**恰好导航 ⇒
     * 从此再也匹配不上 ⇒ 表症与本次报障**一模一样**（白转 4 分钟）。
     *
     * ⚠️ 这里**故意用运行时拼出的 18 位数字**（而不是字面量）：真机取证时那个
     * workspace id 属于**具体用户**，写进仓库就是一条个人痕迹（脱敏审计会命中
     * 「身份证号」那条形状规则）。本用例只关心「路径多一段数字」，形状一致即可。
     */
    const workspaceUrl = `https://www.letsmagic.cn/global/super/workspace/${'1'.repeat(18)}`
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') {
        return targetsWith(workspaceUrl)
      }
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      return loggedInEvaluate()
    })

    expect(await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn']))
      .toEqual({ jwt: JWT_LIVE, organizationCode: 'org-fixture' })
  })

  it('★ 站点写法互认（`www.` 前后）：裸域也算同一个站点', async () => {
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(`https://letsmagic.cn/login`)
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      return loggedInEvaluate()
    })
    expect(await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn'])).toBeDefined()
  })

  it('★ 跳过**不是本站**的 page（别拿别的标签页的 localStorage 顶替）', async () => {
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            { targetId: 'OTHER', type: 'page', url: 'https://example.com/login' },
            { targetId: 'DEVTOOLS', type: 'other', url: LOGIN_PAGE },
            { targetId: 'MINE', type: 'page', url: LOGIN_PAGE },
          ],
        }
      }
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      return loggedInEvaluate()
    })
    await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn'])
    expect(cdp.calls.find((call) => call.method === 'Target.attachToTarget')?.params.targetId)
      .toBe('MINE')
  })

  it('★★ `organizationCode` 缺、`teamshareOrganizationCode` 有 ⇒ 用后者', async () => {
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(LOGIN_PAGE)
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      return evaluateWith({
        authorization: JWT_LIVE,
        organizationCode: null,
        teamshareOrganizationCode: 'ts-org-code',
        length: 2,
      })
    })
    expect(await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn']))
      .toEqual({ jwt: JWT_LIVE, organizationCode: 'ts-org-code' })
  })

  it('★★ `localStorage` 为空（`n === 0`）⇒ undefined，且**不抛**（用户刚点开窗口就是这个态）', async () => {
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(LOGIN_PAGE)
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      return evaluateWith({ length: 0 })
    })
    // ⚠️ 不吃 rejects：若实现改成抛错，这条会以 unexpected rejection 失败，判据相同。
    expect(await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn'])).toBeUndefined()
  })

  it('★★ `n === 0` 是**正常未完成态**、不是故障（诊断里不得记成「读取失败」）', async () => {
    /**
     * ⚠️ 这一格守的是**诊断的语义**，而不是返回值：`n === 0` 与「CDP 调用抛错」在
     * 返回值上同形（都 `undefined`），但放弃等待那一行必须能分开它们 —— 否则
     * 「用户没登」会被记成「我们读的方式坏了」，下次报障又得重新怀疑方向。
     */
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(LOGIN_PAGE)
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      return evaluateWith({ length: 0 })
    })
    const logs: string[] = []
    let time = NOW
    const wait = createMagicrewCredentialWaiter({
      read: () => undefined,
      readRealtime: async () => await readCredentialViaCdpDetailed(cdp.session, ['www.letsmagic.cn']),
      now: () => time,
      sleep: async (ms) => { time += ms },
      log: (message) => logs.push(message),
    })

    expect(await wait(1_000)).toBeUndefined()
    expect(logs).toHaveLength(1)
    // 「无失败原因」那句 = 页面在、只是 localStorage 里还没有凭据 ⇒ 用户没登完。
    expect(logs[0]).toContain('用户没登完')
    expect(logs[0], '`n === 0` 不得被记成 CDP 失败').not.toContain('CDP 调用失败')
    expect(logs[0]).not.toContain('Runtime.evaluate')
  })

  it('★★ `authorization` 不是 JWT 形状 ⇒ undefined（形状不对就一定不是 jwt）', async () => {
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(LOGIN_PAGE)
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      return evaluateWith({
        authorization: 'not-a-jwt-at-all',
        organizationCode: 'org-fixture',
        length: 2,
      })
    })
    expect(await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn'])).toBeUndefined()
  })

  it('★ 有 jwt 但两个组织码都缺 ⇒ undefined（**不造假**：空 org 在上游是 200 + code:403）', async () => {
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(LOGIN_PAGE)
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      return evaluateWith({ authorization: JWT_LIVE, length: 2 })
    })
    expect(await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn'])).toBeUndefined()
  })

  it('★ 没有任何命中站点的 page ⇒ undefined（**不抛**：页面可能还没加载出来）', async () => {
    const cdp = fakeCdp(() => ({ targetInfos: [] }))
    expect(await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn'])).toBeUndefined()
    // 没页面就不该再 attach（省一次无意义的往返）。
    expect(cdp.methods()).toEqual(['Target.getTargets'])
  })

  it('★★ `Target.getTargets` 抛错 ⇒ undefined（**不抛**，下一轮自然重试）', async () => {
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') throw new Error('CDP Target.getTargets 超时（3000ms）')
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      return loggedInEvaluate()
    })
    expect(await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn'])).toBeUndefined()
  })

  it('★ CDP 通道未就绪（`cdp === undefined`）⇒ undefined，不发任何命令', async () => {
    // 覆盖「浏览器还没就绪 / 已收窗」两态：都是正常路径，不是错误。
    expect(await readCredentialViaCdp({ cdp: undefined }, ['www.letsmagic.cn']))
      .toBeUndefined()
  })

  it('★ 每次读都**重新 attach**（页面导航后旧 sessionId 会失效）', async () => {
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(LOGIN_PAGE)
      if (method === 'Target.attachToTarget') return { sessionId: `SESSION-${cdp.calls.length}` }
      return evaluateWith({ length: 0 })
    })
    await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn'])
    await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn'])
    // 两轮各自一次 attach（缓存 sessionId 的实现这里会是 1）。
    expect(cdp.methods().filter((method) => method === 'Target.attachToTarget')).toHaveLength(2)
    expect(cdp.methods().filter((method) => method === 'Runtime.evaluate')).toHaveLength(2)
  })

  it('★★ attach 之后**尽力 detach**（不留 session），detach 失败**不影响**读到的凭据', async () => {
    const ok = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(LOGIN_PAGE)
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      if (method === 'Runtime.evaluate') return loggedInEvaluate()
      return {}
    })
    await readCredentialViaCdp(ok.session, ['www.letsmagic.cn'])
    const detach = ok.calls.find((call) => call.method === 'Target.detachFromTarget')
    expect(detach?.params, 'detach 必须点名那个 sessionId').toEqual({ sessionId: 'SESSION-1' })

    /**
     * ⚠️ 与 `Storage.getCookies` 的既有口径一致（`chromium-session.ts` 同名注释）：
     * detach **不可用/失败都不得**让「已经读到的凭据」变成读不到 —— 有的 Chromium
     * 版本/调试后端没有 `Target.detachFromTarget`，为它抛错就是自己废掉主路径。
     */
    const noDetach = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(LOGIN_PAGE)
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      if (method === 'Runtime.evaluate') return loggedInEvaluate()
      throw new Error("-32601 'Target.detachFromTarget' wasn't found")
    })
    expect(await readCredentialViaCdp(noDetach.session, ['www.letsmagic.cn']))
      .toEqual({ jwt: JWT_LIVE, organizationCode: 'org-fixture' })
  })
})

// ════════════════════════════════════════════════════════════════════════
// ③c 实时 + 磁盘两腿的优先级（接进等待循环）
// ════════════════════════════════════════════════════════════════════════

describe('等待循环：CDP 实时优先 / 磁盘兜底', () => {
  function clock() {
    let time = NOW
    const waits: number[] = []
    return {
      now: () => time,
      sleep: async (ms: number) => { waits.push(ms); time += ms },
      waits,
      get time() { return time },
    }
  }

  it('★★ 磁盘里**已经有**凭据、CDP 也读到 ⇒ 返回 **CDP 那份**（实时优先）', async () => {
    const clk = clock()
    const realtime: MagicrewCredential = { jwt: JWT_LIVE, organizationCode: 'from-cdp' }
    const wait = createMagicrewCredentialWaiter({
      read: () => ({ jwt: JWT_LIVE, organizationCode: 'from-disk' }),
      readRealtime: () => ({ credential: realtime }),
      now: clk.now,
      sleep: clk.sleep,
    })
    expect(await wait(60_000)).toEqual(realtime)
  })

  it('★★ CDP 一直读不到、磁盘有凭据 ⇒ 返回**磁盘那份**（CDP 不可用的老 Chromium 也登得进去）', async () => {
    const clk = clock()
    const fromDisk: MagicrewCredential = { jwt: JWT_LIVE, organizationCode: 'from-disk' }
    let realtimeCalls = 0
    const wait = createMagicrewCredentialWaiter({
      read: () => fromDisk,
      readRealtime: () => {
        realtimeCalls += 1
        return { failure: 'CDP 通道未就绪（浏览器未启动或已收窗）' }
      },
      now: clk.now,
      sleep: clk.sleep,
    })
    expect(await wait(60_000)).toEqual(fromDisk)
    // 单拍就够（CDP 那拍失败后立刻走磁盘兜底，不必等下一轮）。
    expect(realtimeCalls).toBe(1)
    expect(clk.waits).toEqual([])
  })

  it('★★ `n === 0`（还没登完）⇒ 后续轮次能读到：第 3 轮拿到', async () => {
    const clk = clock()
    let round = 0
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') return targetsWith(LOGIN_PAGE)
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      if (method !== 'Runtime.evaluate') return {}
      round += 1
      // 前两拍页面里 `localStorage.length === 0`（用户还在输密码）。
      return round < 3 ? evaluateWith({ length: 0 }) : loggedInEvaluate()
    })
    const wait = createMagicrewCredentialWaiter({
      read: () => undefined,
      readRealtime: async () => ({ credential: await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn']) }),
      now: clk.now,
      sleep: clk.sleep,
    })

    expect(await wait(60_000)).toEqual({ jwt: JWT_LIVE, organizationCode: 'org-fixture' })
    expect(round, '第 3 轮才读到').toBe(3)
    expect(clk.waits, '前两拍各睡一个完整间隔').toEqual([
      MAGICREW_BROWSER_LOGIN_POLL_MS,
      MAGICREW_BROWSER_LOGIN_POLL_MS,
    ])
  })

  it('★★ `Target.getTargets` 抛错 ⇒ 本轮 undefined，**下一轮仍然重试**（send 被调 > 1 次）', async () => {
    const clk = clock()
    let targetCalls = 0
    let failUntil = 2
    const cdp = fakeCdp(({ method }) => {
      if (method === 'Target.getTargets') {
        targetCalls += 1
        if (targetCalls <= failUntil) throw new Error('CDP Target.getTargets 超时（3000ms）')
        return targetsWith(LOGIN_PAGE)
      }
      if (method === 'Target.attachToTarget') return { sessionId: 'SESSION-1' }
      return loggedInEvaluate()
    })
    const wait = createMagicrewCredentialWaiter({
      read: () => undefined,
      readRealtime: async () => ({ credential: await readCredentialViaCdp(cdp.session, ['www.letsmagic.cn']) }),
      now: clk.now,
      sleep: clk.sleep,
    })

    expect(await wait(60_000)).toEqual({ jwt: JWT_LIVE, organizationCode: 'org-fixture' })
    expect(targetCalls, '失败两拍之后仍然重试 ⇒ 至少 3 次').toBeGreaterThan(1)
    expect(targetCalls).toBe(3)
  })

  it('★★ 放弃等待 ⇒ 日志留一行（CDP 次数 + 最后一次失败原因），区分「没登」与「读坏了」', async () => {
    const clk = clock()
    const logs: string[] = []
    const wait = createMagicrewCredentialWaiter({
      read: () => undefined,
      readRealtime: () => ({ failure: 'CDP 通道未就绪（浏览器未启动或已收窗）' }),
      now: clk.now,
      sleep: clk.sleep,
      log: (message) => logs.push(message),
      pollIntervalMs: 500,
    })

    expect(await wait(1_000)).toBeUndefined()
    expect(logs).toHaveLength(1)
    // ⚠️ 文案三件都在：两个来源都空、CDP 尝试次数、最后一次失败原因。
    expect(logs[0]).toContain('CDP 与磁盘都没读到凭据')
    expect(logs[0]).toContain('CDP 尝试 3 次')
    expect(logs[0]).toContain('CDP 通道未就绪')
  })

  it('★ 读到凭据 ⇒ **不**记那行诊断（别把成功也记成「读不到」）', async () => {
    const logs: string[] = []
    const wait = createMagicrewCredentialWaiter({
      read: () => ({ jwt: JWT_LIVE, organizationCode: 'org-cn' }),
      readRealtime: () => ({ credential: { jwt: JWT_LIVE, organizationCode: 'org-cn' } }),
      now: () => NOW,
      sleep: async () => { throw new Error('不该睡') },
      log: (message) => logs.push(message),
    })
    expect(await wait(60_000)).toBeDefined()
    expect(logs).toEqual([])
  })

  it('★ 实时读**抛错**也只是「这拍没读到」（等待不能因它失败）', async () => {
    const clk = clock()
    const wait = createMagicrewCredentialWaiter({
      read: () => undefined,
      readRealtime: () => { throw new Error('boom') },
      now: clk.now,
      sleep: clk.sleep,
    })
    expect(await wait(1_000)).toBeUndefined()
    expect(clk.waits).toEqual([MAGICREW_BROWSER_LOGIN_POLL_MS, MAGICREW_BROWSER_LOGIN_POLL_MS])
  })
})

// ════════════════════════════════════════════════════════════════════════
// ④ 找不到浏览器：文案必须来自 browserNotFoundMessage
// ════════════════════════════════════════════════════════════════════════

describe('createChromiumMagicrewLogin：找不到浏览器', () => {
  it('★★ 抛 BrowserDeploymentError + 带 browserNotFoundMessage 的分平台提示（**零进程**）', async () => {
    // ⚠️ `resolveBrowser: () => undefined` ⇒ 在 spawn **之前**就抛，绝不真起浏览器。
    await expect(
      createChromiumMagicrewLogin(ORIGIN_CN, { resolveBrowser: () => undefined }),
    ).rejects.toMatchObject({
      name: 'BrowserDeploymentError',
      deployKind: 'browser-not-found',
    })
  })

  it('★ 文案里必须**有**平台提示与「本进程看到的候选」两截（不是自己编一句话）', async () => {
    let message = ''
    try {
      await createChromiumMagicrewLogin(ORIGIN_CN, {
        resolveBrowser: () => undefined,
        platform: 'win32',
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // 平台提示（`browserNotFoundMessage` 的 win32 分支逐字含这几个词）
    expect(message).toContain('scoop chromium')
    expect(message).toContain('ZCODE_CHROME_PATH')
    // 诊断段：候选清单回显（用户唯一能自查的东西）
    expect(message).toContain('本次已尝试')
    expect(message).toContain('本进程看到的 ZCODE_CHROME_PATH')
    // 产品前缀，用户才知道是哪一家在要浏览器
    expect(message).toContain('超级麦吉')
  })

  it('★ 非法 origin ⇒ 立刻可读错误（不起浏览器、不装作在等）', async () => {
    await expect(
      createChromiumMagicrewLogin('not-a-url', { resolveBrowser: () => '/fake/chrome' }),
    ).rejects.toThrow(/网页登录地址非法/)
  })
})

// ════════════════════════════════════════════════════════════════════════
// ⑤ MagicrewAuth.loginViaBrowser：签发 + 落库 + 收窗
// ════════════════════════════════════════════════════════════════════════

describe('MagicrewAuth.loginViaBrowser', () => {
  const CREDENTIAL: MagicrewCredential = { jwt: JWT_LIVE, organizationCode: 'org-cn' }

  function makeAuth(store: FakeStore, session: MagicrewBrowserLogin, extra: {
    fetchImpl?: typeof fetch
    warn?: (message: string) => void
    onFactory?: (options: { timeoutMs?: number } | undefined) => void
    /** 注入的账号资料取数器（昵称）；缺省 = 真取数器（走注入的假 `fetchImpl`）。 */
    profileFetcher?: (params: {
      jwt: string
      organizationCode: string
      product: MagicrewProduct
    }) => Promise<MagicrewProfile>
  } = {}) {
    return new MagicrewAuth(makeContext(store), {
      store,
      fetchImpl: extra.fetchImpl ?? ((async () => keyEnvelope()) as unknown as typeof fetch),
      ...extra.warn === undefined ? {} : { warn: extra.warn },
      ...extra.profileFetcher === undefined ? {} : { profileFetcher: extra.profileFetcher },
      browserLoginFactory: async (options) => {
        extra.onFactory?.(options)
        return session
      },
    })
  }

  it('★★ 登完 ⇒ **签发恰好一次** key、写进 defaultCredentialRef、返回完整凭据', async () => {
    const store = new FakeStore()
    const fetchImpl = vi.fn(async () => keyEnvelope())
    /**
     * ⚠️ 假会话的 `waitForCredential` 被 `loginViaBrowser` **只调一次** —— 轮询
     * 藏在会话**内部**（`createMagicrewCredentialWaiter`，见上面 ② 组的用例）。
     * ⇒ 这条用例的结果表只有一项；「第 3 拍才读到」那种形态属于 ② 组。
     */
    const session = fakeSession({ results: [CREDENTIAL] })
    const auth = makeAuth(store, session, { fetchImpl: fetchImpl as unknown as typeof fetch })

    const credential = await auth.loginViaBrowser()

    expect(credential?.jwt).toBe(JWT_LIVE)
    expect(credential?.organizationCode).toBe('org-cn')
    expect(credential?.apiKey).toBe('mgw_from-web-login')
    expect(credential?.refreshToken).toBe('rt_from-web-login')
    expect(credential?.apiKeyExpiresAt).toBe(NOW + 7200_000)

    // ⚠️⚠️ **恰好一次**：签新 key 会吊销旧 key（本家最贵的错误）。
    // ⚠️ 2026-10-29 起这条腿会**再发一次**请求（取账号资料 / 昵称）⇒ 按 URL 分开数，
    //    「签发恰好一次」这条守卫的牙齿不能因为多了一条腿而消失。
    const keyCalls = fetchImpl.mock.calls.filter(
      (call) => String(call[0]).includes(MAGICREW_GATEWAY_TOKENS_PATH),
    )
    expect(keyCalls).toHaveLength(1)
    expect(fetchImpl.mock.calls.map((call) => String(call[0])))
      .toEqual([`${MAGICREW.host}${MAGICREW_GATEWAY_TOKENS_PATH}`, `${MAGICREW.host}${MAGICREW_PROFILE_PATH}`])
    const [url, init] = keyCalls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${MAGICREW.host}${MAGICREW_GATEWAY_TOKENS_PATH}`)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${JWT_LIVE}`)
    expect((init.headers as Record<string, string>)['organization-code']).toBe('org-cn')

    // 落库到默认 ref（宿主只收字符串）。
    const saved = store.saved(MAGICREW.defaultCredentialRef)
    expect(saved?.jwt).toBe(JWT_LIVE)
    expect(saved?.apiKey).toBe('mgw_from-web-login')
  })

  it('★★ 用户没登完（超时）⇒ undefined，且**零签发、零写入**', async () => {
    const store = new FakeStore()
    const fetchImpl = vi.fn(async () => keyEnvelope())
    const session = fakeSession({ results: [undefined] })
    const auth = makeAuth(store, session, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(await auth.loginViaBrowser()).toBeUndefined()
    expect(fetchImpl, '没登完就签发 = 白吊销一把在用的 key').not.toHaveBeenCalled()
    expect(store.setCalls).toEqual([])
  })

  it('★★ 网页版登录也取昵称（两条登录腿必须同改，漏一条就是「两条路径显示不一样」）', async () => {
    const store = new FakeStore()
    const asked: { jwt: string, organizationCode: string }[] = []
    const session = fakeSession({ results: [CREDENTIAL] })
    const auth = makeAuth(store, session, {
      profileFetcher: async (params) => {
        asked.push({ jwt: params.jwt, organizationCode: params.organizationCode })
        return { nickname: 'Nick', realName: 'Nick', phone: '1380000000' }
      },
    })

    const credential = await auth.loginViaBrowser()

    expect(credential?.nickname).toBe('Nick')
    expect(asked).toEqual([{ jwt: JWT_LIVE, organizationCode: 'org-cn' }])
    expect(store.saved(MAGICREW.defaultCredentialRef)?.nickname).toBe('Nick')
  })

  it('★★ 取昵称失败 ⇒ 网页版登录**照常成功**，但必须 warn 留痕', async () => {
    const store = new FakeStore()
    const warnings: string[] = []
    const session = fakeSession({ results: [CREDENTIAL] })
    const auth = makeAuth(store, session, {
      warn: (message) => warnings.push(message),
      profileFetcher: async () => { throw new Error('HTTP 502') },
    })

    const credential = await auth.loginViaBrowser()

    expect(credential?.jwt, '昵称取不到不该让登录失败').toBe(JWT_LIVE)
    expect(credential?.nickname).toBeUndefined()
    expect(warnings.join('\n')).toMatch(/读取账号资料失败/)
    expect(store.saved(MAGICREW.defaultCredentialRef)?.apiKey).toBe('mgw_from-web-login')
  })

  it('★★ 无论成功还是超时，`close()` 都**恰好**被调一次（否则窗口残留）', async () => {
    const store = new FakeStore()
    const done = fakeSession({ results: [CREDENTIAL] })
    await makeAuth(store, done).loginViaBrowser()
    expect(done.closeCalls).toBe(1)

    const timedOut = fakeSession({ results: [undefined] })
    await makeAuth(new FakeStore(), timedOut).loginViaBrowser()
    expect(timedOut.closeCalls).toBe(1)
  })

  it('⚠️ `waitForCredential` 抛错 ⇒ 仍然 `close()`，且错误向上冒（不静默吞掉）', async () => {
    const store = new FakeStore()
    let closed = 0
    const session: MagicrewBrowserLogin = {
      close: () => { closed += 1 },
      waitForCredential: async () => { throw new Error('浏览器崩了') },
    }
    const auth = makeAuth(store, session)
    await expect(auth.loginViaBrowser()).rejects.toThrow(/浏览器崩了/)
    expect(closed, 'finally 必须在抛错路径上也收窗').toBe(1)
  })

  it('★★ 签发失败**不吞掉**登录结果，但必须 warn（不许静默）', async () => {
    const store = new FakeStore()
    const warnings: string[] = []
    const session = fakeSession({ results: [CREDENTIAL] })
    const auth = makeAuth(store, session, {
      fetchImpl: (async () => { throw new Error('gateway down') }) as unknown as typeof fetch,
      warn: (message) => warnings.push(message),
    })

    const credential = await auth.loginViaBrowser()
    expect(credential, 'jwt 能拉目录/积分 ⇒ 不许因为签发失败就丢整个结果').toBeDefined()
    expect(credential?.jwt).toBe(JWT_LIVE)
    expect(credential?.apiKey).toBeUndefined()
    expect(warnings.join('\n')).toMatch(/签发 gateway key 失败/)
    // 仍然落库（只有 jwt 的凭据可由续期救回）。
    expect(store.saved(MAGICREW.defaultCredentialRef)?.jwt).toBe(JWT_LIVE)
  })

  it('★ 把 product 与 timeoutMs 交给工厂（超时由调用方说了算）', async () => {
    const store = new FakeStore()
    let seen: { timeoutMs?: number } | undefined
    const session = fakeSession({ results: [undefined] })
    const auth = makeAuth(store, session, { onFactory: (options) => { seen = options } })
    await auth.loginViaBrowser({ timeoutMs: 1_234 })
    expect(seen).toMatchObject({ timeoutMs: 1_234 })
  })

  it('★★ 用户等的时候插件被停用 ⇒ undefined（不把凭据写进一个已停用的插件）', async () => {
    const store = new FakeStore()
    const fetchImpl = vi.fn(async () => keyEnvelope())
    let auth: MagicrewAuth | undefined
    const session = fakeSession({
      results: [CREDENTIAL],
      // 恰好在这一轮「读到凭据」之后、签发之前停用（模拟分钟级等待期间插件被关）。
      onWait: () => { auth?.stop() },
    })
    auth = makeAuth(store, session, { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(await auth.loginViaBrowser()).toBeUndefined()
    expect(fetchImpl, '已停用 ⇒ 连签发都不该发').not.toHaveBeenCalled()
    expect(store.setCalls).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════
// ⑥ MagicrewService：薄委托
// ════════════════════════════════════════════════════════════════════════

describe('MagicrewService.loginViaBrowser', () => {
  it('★ 薄委托到 auth（读到什么就返回什么）', async () => {
    const store = new FakeStore()
    const session = fakeSession({
      results: [{ jwt: JWT_LIVE, organizationCode: 'org-cn' }],
    })
    const auth = new MagicrewAuth(makeContext(store), {
      store,
      fetchImpl: (async () => keyEnvelope()) as unknown as typeof fetch,
      browserLoginFactory: async () => session,
    })
    const service = new MagicrewService({ auth })
    expect((await service.loginViaBrowser())?.organizationCode).toBe('org-cn')
  })

  it('未注入 auth ⇒ **抛错**（不把装配缺陷伪装成「用户没登完」）', async () => {
    const service = new MagicrewService({})
    await expect(service.loginViaBrowser()).rejects.toThrow(/未注入 `auth`/)
  })
})

// ════════════════════════════════════════════════════════════════════════
// ⑦ RPC `account.create` 的 `mode: 'browser'` 三步式（真跑 handler）
// ════════════════════════════════════════════════════════════════════════

/**
 * 搭一个能跑 `account.create` / `account.list` / `login.poll` 的最小环境。
 *
 * ⚠️ 与 `magicrew-local-browser.spec.ts` 的同名 helper **刻意分开**：那边注入的是
 * `browserRoots`（读真实目录的替身），这边注入的是 `browserLoginFactory`（假会话）。
 * 合并成一个 helper 会让「这份用例到底走哪条腿」变成靠参数猜。
 */
async function setupRpc(script: {
  results: readonly (MagicrewCredential | undefined)[]
  /** `loginViaBrowser` 抛这个错（模拟「浏览器起不来」）。 */
  throwError?: Error
  /**
   * 「用户还在窗口里操作」的闸门：给了就**卡住**假会话，直到用例 `release()`。
   *
   * ⚠️ 这条闸门是本组唯一能证明「`account.create` 真的**不**在等用户」的手段：
   * 没有它，假会话会立刻返回 ⇒ 后台任务瞬间落定 ⇒ 占位条目已被删掉，
   * 「立刻返回」与「同步等到结束」两种实现在断言上**不可区分**。
   */
  gate?: boolean
  /** 注入的账号资料取数器（昵称）；缺省 = 真取数器（走注入的假 `fetchImpl`）。 */
  profileFetcher?: (params: {
    jwt: string
    organizationCode: string
    product: MagicrewProduct
  }) => Promise<MagicrewProfile>
  /** 可换的网关信封（缺省 `keyEnvelope()`）—— 用来钉「有效期回落 JWT exp」那条腿。 */
  keyEnvelope?: () => Response
  /**
   * 用例驱动的 provider id（缺省 `'magicrew'`）。
   *
   * ⚠️ 2026-11-01 测试有效性审查（**阻断项**）：原先三组 `account.create` 全部只
   * 驱动 `provider: 'magicrew'`，`src/jet-hub-rpc.ts` 的
   * `magicrewSite` / `magicrewAuthOf` 分流里 **intl 分支零覆盖**。实测把那行
   * `magicrewIntl ? auths.magicrewintl : auths.magicrew` 改成恒 `auths.magicrew`
   * 后，332 条相关用例**全绿** —— 而生产上国际站账号会走国内 auth
   * （读 letsmagic.cn 的 localStorage、写 `MAGICREW_ACCOUNT_*` 前缀）。
   * ⇒ 参数化它，两站各跑一遍。
   */
  provider?: MagicrewProduct['id']
}) {
  let stored: Record<string, unknown> = { accounts: [], disabledModels: {} }
  const ctxLike = new Context() as never as {
    provide: (name: string, value: unknown) => void
    get: (name: string) => unknown
  }
  const store = new FakeStore()
  const credentials = store as unknown as {
    resolve: (ref: unknown) => Promise<{ value: string } | undefined>
    set: (ref: unknown, value: string) => Promise<void>
    unset: (ref: unknown) => Promise<void>
  }
  ctxLike.provide('credentials', credentials)
  const pool = new AccountPool({
    get: (key: string) => key === 'settings'
      ? {
          register: () => ({
            get: () => stored,
            replace: async (value: Record<string, unknown>) => { stored = value },
          }),
        }
      : undefined,
    logger: { warn: () => {}, info: () => {} },
    credentials,
  } as never)
  ctxLike.provide('accountPool', pool)

  let releaseGate: () => void = () => {}
  const gate = {
    promise: new Promise<void>((resolve) => { releaseGate = resolve }),
    resolve: () => { releaseGate() },
  }
  const warnings: string[] = []
  /**
   * 按站点分流的假会话记录（`'magicrew'` / `'magicrewintl'`）。
   *
   * ⚠️ 必须**分开记**：两站共用同一套 `browserLoginFactory` 注入点，
   * 若只用一个数组，「国际站账号误用国内 auth」就只剩 `provider` 字段能看出来，
   * 而那条线索在 `account.create` 里是入参、不是行为。分开记才能断言
   * 「**这个站**的 auth 真的被调用了」。
   */
  const sessionsBySite: Record<string, ReturnType<typeof fakeSession>[]> = {
    magicrew: [],
    magicrewintl: [],
    /**
     * ⚠️ **`loginOptions.product` 缺席**的调用单独落这个桶（2026-11-01 二审）。
     *
     * 原判据是 `loginOptions?.product?.id ?? product.id` —— 那个 `??` 回落把
     * 「没传 product」与「传对了」混成同一桶 ⇒ **守卫是假牙**：
     * 实测把 `src/magicrew-auth.ts:987` 的 `{ product: this.product, timeoutMs }`
     * 改成 `{ timeoutMs }`，全量 11693 条**一条都不红**。
     *
     * 而生产后果很重：`startMagicrewBrowserLogin` 取 `options.product ?? MAGICREW`
     * （`src/magicrew-browser-login.ts:920`）⇒ 国际站用户点「网页登录」打开的是
     * **www.letsmagic.cn/login**，登完后的**国内 JWT 落进 `MAGICREWINTL_ACCOUNT_*`**
     * （凭据与站点串号，且卡片上看起来一切正常）。
     *
     * ⇒ 缺席一律记到本桶，用例断言它必须为空。
     */
    '__no-product__': [],
  }
  const makeAuth = (product: MagicrewProduct) => new MagicrewAuth(ctxLike as never, {
    product,
    store,
    fetchImpl: (async () => (script.keyEnvelope ?? keyEnvelope)()) as unknown as typeof fetch,
    warn: (message) => warnings.push(`[${product.id}] ${message}`),
    ...script.profileFetcher === undefined ? {} : { profileFetcher: script.profileFetcher },
    browserLoginFactory: async (loginOptions) => {
      if (script.throwError !== undefined) throw script.throwError
      const session = fakeSession({ results: script.results })
      // ⚠️ **禁止回落**：记录用的站点只能取自 `loginOptions.product`。
      //    写成 `?? product.id` 会让「调用方漏传 product」不可见（见桶上方的注释）。
      const siteOf = loginOptions?.product?.id ?? '__no-product__'
      ;(sessionsBySite[siteOf] ??= []).push(session)
      if (script.gate === true) {
        // 卡在 `waitForCredential` 里 = 「用户还没登完」。
        const gated: MagicrewBrowserLogin & { closeCalls: number } = {
          closeCalls: session.closeCalls,
          close: () => session.close(),
          waitForCredential: async () => {
            await gate.promise
            return session.waitForCredential(0)
          },
        }
        return gated
      }
      return session
    },
  })
  const magicrewAuth = makeAuth(MAGICREW)
  // ⚠️ **必须并存两份实例**：`MagicrewAuth` 构造时按 `${product.id}Auth` 自 provide，
  //    两个实例在同一 ctx 上互不覆盖；`account.create` 靠 `auths.magicrewintl` 分流。
  const magicrewIntlAuth = makeAuth(MAGICREW_INTL)

  let handler: ((req: Request) => Promise<Response>) | undefined
  const rpcCtx = {
    credentials,
    get: (key: string) => {
      if (key === 'connection') {
        return {
          fetch: {
            register: (config: { path: string, fetch: typeof handler }) => {
              if (config.path === JET_HUB_API_PATH) handler = config.fetch
            },
          },
        }
      }
      if (key === 'credentials') return credentials
      if (key === 'llm') return { listModels: async () => [], resolveModelInfo: async () => ({}) }
      return undefined
    },
    inject: (_deps: string[], cb: (c: unknown) => void) => { cb(rpcCtx) },
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    emit: () => {},
  }
  registerJetHubRpc(rpcCtx as never, pool, {
    magicrew: magicrewAuth,
    magicrewintl: magicrewIntlAuth,
    codearts: {}, buddy: {}, workbuddy: {}, lobsterai: {}, qoder: {}, qodercn: {},
    trae: {}, cline: {}, loomy: {}, raccoon: {}, minimax: {}, zcode: {},
    gemini: {}, officeace: {}, minimaxintl: {}, autoclaw: {}, accio: {},
    opencode: {},
  } as never)
  if (handler === undefined) throw new Error('RPC handler 未注册')

  const invoke = async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean, value?: unknown, error?: { message: string } }
    }
    return body.result
  }

  return {
    pool,
    store,
    /** 当前 provider 那一站的假会话记录（向后兼容旧用例）。 */
    sessions: sessionsBySite[script.provider ?? 'magicrew'] ?? [],
    /** 按站点取假会话记录（两站串号守卫用）。 */
    sessionsBySite,
    /** 收集到的 warn（断言「不许静默」用）。 */
    warnings,
    /** 放开闸门（让后台那一轮落定）。 */
    release: () => { gate.resolve() },
    callCreate: () => invoke('account.create', { provider: script.provider ?? 'magicrew', mode: 'browser' }),
    callPoll: (accountId: string) => invoke('login.poll', { accountId, provider: script.provider ?? 'magicrew' }),
    callList: () => invoke('account.list', { provider: script.provider ?? 'magicrew' }),
    /**
     * 等后台任务落定。
     *
     * ⚠️ 必须**真的等**（而不是断言后 `await sleep(0)`）：后台任务是 `void` 起的，
     * 但 `login.poll` 会 `await` 同一份 promise ⇒ 用 `login.poll` 当同步点，
     * 不引入任何固定延迟（固定延迟是本仓库明令禁止的 flaky 源）。
     */
  }
}

describe("★ account.create({ provider: 'magicrew', mode: 'browser' }) 三步式", () => {
  const CREDENTIAL: MagicrewCredential = { jwt: JWT_LIVE, organizationCode: 'org-cn' }

  it('★★ `account.create` **立刻**返回（不等用户，2–5 分钟的等待留在后台）+ 占位条目就位', async () => {
    // ⚠️ `gate: true` ⇒ 假会话**卡在**「用户还没登完」的状态。若实现改成同步等，
    //    这条用例会**挂死**（或超时失败），从而与「立刻返回」实现区分开。
    const { callCreate, pool, sessions, release } = await setupRpc({
      results: [CREDENTIAL],
      gate: true,
    })

    const created = await callCreate()
    expect(created.ok, `应当成功：${created.error?.message ?? ''}`).toBe(true)
    const value = created.value as { accountId: string, loginUrl: string }
    expect(value.loginUrl, '窗口由宿主开 ⇒ loginUrl 是空串').toBe('')
    expect(value.accountId.length).toBeGreaterThan(0)
    // 占位条目：**先登记再开窗**（`login.poll` 在这一秒内就可能问到它）。
    expect(pool.findAccount(value.accountId), '占位条目必须在 create 返回时就已就位').toBeDefined()
    expect(pool.findAccount(value.accountId)?.provider).toBe('magicrew')
    // 假会话被真的起了一次（= 宿主开了窗口）。
    expect(sessions).toHaveLength(1)
    // 此时**还没有**凭据（用户还在窗口里）—— 这正是「不等用户」的证据。
    expect(pool.findAccount(value.accountId)?.expiresAt).toBeUndefined()
    release()
  })

  it('★★ 用户登完 ⇒ `login.poll` 报 `done:true, success:true`，凭据落在**该账号自己的** ref 上', async () => {
    const { callCreate, callPoll, pool, store } = await setupRpc({ results: [CREDENTIAL] })

    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    const polled = await callPoll(accountId)

    expect(polled.ok).toBe(true)
    expect(polled.value).toEqual({ done: true, success: true })

    const entry = pool.readAccounts().find((candidate) => candidate.id === accountId)
    expect(entry?.credentialRef).toMatch(/^MAGICREW_ACCOUNT_/)
    // 凭据写在该账号自己的 ref（不是只写 default ref —— 那样多账号会互相覆盖）。
    expect(store.saved(entry!.credentialRef)?.jwt).toBe(JWT_LIVE)
    // 昵称 / 有效期回填。
    expect(entry?.expiresAt).toBe(NOW + 7200_000)
    expect(entry?.refreshable).toBe(true)
  })

  it('★★ 用户没登完（超时/关窗）⇒ `done:true, success:false` + 可读原因，且**删掉占位条目**', async () => {
    const { callCreate, callPoll, pool } = await setupRpc({ results: [undefined] })

    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    const polled = await callPoll(accountId)

    expect(polled.ok).toBe(true)
    // ⚠️ 三态契约（IKLI7J）：失败必须是 `done:true` + `success:false` + `error`，
    //   否则前端 `if (!pollRes?.done) return;` 会把它整体丢掉 ⇒ 静默转圈 5 分钟。
    expect(polled.value).toMatchObject({ done: true, success: false })
    expect((polled.value as { error: string }).error).toMatch(/网页登录未完成/)
    // 不留幽灵卡片。
    expect(pool.findAccount(accountId)).toBeUndefined()
  })

  it('★★ 浏览器起不来 ⇒ `done:true, success:false`，错误文案**原样**带出「找不到浏览器」的提示', async () => {
    const { callCreate, callPoll, pool } = await setupRpc({
      results: [undefined],
      throwError: new BrowserDeploymentError(
        '超级麦吉: 找不到可用的浏览器（网页登录需要本机有一个 Chromium 内核浏览器）。'
          + '已尝试 scoop chromium / Chrome / Chromium / Brave / Edge；可用 ZCODE_CHROME_PATH 显式指定 chrome.exe 路径。',
        'browser-not-found',
      ),
    })

    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    const polled = await callPoll(accountId)

    expect(polled.value).toMatchObject({ done: true, success: false })
    const error = String((polled.value as { error: string }).error)
    // ⚠️ 用户唯一能自救的那句话必须送到眼前（不能被包装成「登录失败」）。
    expect(error).toContain('ZCODE_CHROME_PATH')
    expect(pool.findAccount(accountId)).toBeUndefined()
  })

  it('★★ 同一上游账号已有卡片 ⇒ 不造第二张，凭据转写到**保留卡**、删掉本次占位条目', async () => {
    const { callCreate, callPoll, pool, store } = await setupRpc({ results: [CREDENTIAL] })

    const first = await callCreate()
    await callPoll((first.value as { accountId: string }).accountId)
    const firstEntry = pool.readAccounts().find(
      (candidate) => candidate.id === (first.value as { accountId: string }).accountId,
    )!

    // 第二次登录拿到**同一个** jwt（同一上游账号）。
    const second = await callCreate()
    const secondId = (second.value as { accountId: string }).accountId
    const polled = await callPoll(secondId)

    expect(polled.value).toEqual({ done: true, success: true })
    const accounts = pool.listAccountsByProvider('magicrew')
    expect(accounts, '同一份凭据必须复用原卡（fp 判重）').toHaveLength(1)
    expect(accounts[0]?.id).toBe(firstEntry.id)
    expect(store.saved(firstEntry.credentialRef)?.jwt).toBe(JWT_LIVE)
  })

  it('★★ 网页版登录的卡片昵称 = 上游真实昵称（不是「超级麦吉」）', async () => {
    const { callCreate, callPoll, pool } = await setupRpc({
      results: [CREDENTIAL],
      profileFetcher: async () => ({ nickname: 'Nick', realName: 'Nick', phone: '1380000000' }),
    })

    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    await callPoll(accountId)

    expect(pool.findAccount(accountId)?.nickname).toBe('Nick')
    // ⚠️ 两条腿都要取昵称：这一格与 `local-browser` 那一格是**同一份判据的两处接线**
    //    （漏一处 = 其中一条登录路径的卡片仍显示渠道名）。
    expect((pool.findAccount(accountId)?.nickname)).not.toBe('超级麦吉')
  })

  it('⚠️ 取昵称失败 ⇒ 网页版登录仍然 `success:true`（只留痕），且卡片回落渠道名', async () => {
    const { callCreate, callPoll, pool, warnings } = await setupRpc({
      results: [CREDENTIAL],
      profileFetcher: async () => { throw new Error('HTTP 502') },
    })

    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    const polled = await callPoll(accountId)

    expect(polled.value, '昵称是展示名，取不到不该把登录判成失败').toEqual({ done: true, success: true })
    expect(pool.findAccount(accountId)?.nickname).toBe('超级麦吉')
    expect(warnings.join('\n')).toMatch(/读取账号资料失败/)
  })

  it('★★ 凭据没有 `api_key_expires_at` ⇒ 卡片有效期取 **JWT 的 exp**（与 local-browser 腿同一条判据）', async () => {
    const { callCreate, callPoll, pool } = await setupRpc({
      results: [CREDENTIAL],
      // 与真机凭据同形：没有任何到期时刻字段。
      keyEnvelope: () => keyEnvelope(undefined, undefined, false),
    })

    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    await callPoll(accountId)

    // `JWT_LIVE.exp` 是秒 ⇒ 卡片用毫秒。
    expect(pool.findAccount(accountId)?.expiresAt).toBe((Math.floor(NOW / 1000) + 3600) * 1000)
  })
})

// ════════════════════════════════════════════════════════════════════════
// ⑧ 占位条目收口（宿主重启后的残留）
// ════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════
// ⑦c 两站分流守卫：`magicrewintl` 必须走**自己**的 auth 实例（2026-11-01）
// ════════════════════════════════════════════════════════════════════════

/**
 * ★★ **国际站账号必须走 `auths.magicrewintl`，不得串到国内站**。
 *
 * ## 为什么必须有这条（测试有效性审查的**阻断项**）
 *
 * 上面那组三步式只驱动 `provider: 'magicrew'`，`src/jet-hub-rpc.ts` 里
 * `magicrewIntl ? auths.magicrewintl : auths.magicrew` 的 intl 分支**零覆盖**。
 * 实测把该行改成恒 `auths.magicrew` 后，332 条用例**全绿**。
 *
 * 生产症状（三连）：国际站账号
 * ① 起窗时读的是 `www.letsmagic.cn` 的登录态（必然读不到 / 读到别人的）；
 * ② 写凭据时用国内站的 ref 前缀 `MAGICREW_ACCOUNT_*` ⇒ 与国内账号**共用 ref 命名空间**；
 * ③ 续期打国内 host ⇒  silently 失败。
 * 全程零报错，用户只看到「导入失败」或卡片名字不对。
 *
 * ⚠️ 判据用**两个独立 auth 实例各自的假会话记录**（`sessionsBySite`），
 * 而不是看 `account.provider` 字段 —— 后者是入参回显，串号时照样是对的。
 */
describe('★★ 国际站 account.create 必须走 magicrewintl 的 auth（两站串号守卫）', () => {
  const CREDENTIAL: MagicrewCredential = { jwt: JWT_LIVE, organizationCode: 'org-intl' }

  it('provider: magicrewintl 时只调用国际站 auth，国内站 auth 零调用', async () => {
    const { callCreate, pool, sessionsBySite, release } = await setupRpc({
      results: [CREDENTIAL],
      // ⚠️ `gate: true`：让假会话卡在「用户还没登完」，否则后台任务瞬间落定、
      //    占位条目被删掉，`accountId` 就取不到了。
      gate: true,
      provider: 'magicrewintl',
    })

    const created = await callCreate()
    expect(created.ok, `应当成功：${created.error?.message ?? ''}`).toBe(true)
    const value = created.value as { accountId: string }

    // ① 占位条目的 provider 必须是国际站（串号时会写成 magicrew）。
    expect(pool.findAccount(value.accountId)?.provider, '国际站账号被记成了国内站')
      .toBe('magicrewintl')

    // ② **行为判据**：只有国际站的 auth 起了窗口。
    expect(
      sessionsBySite.magicrew,
      '国际站账号的窗口是**国内站** auth 起的 —— `magicrewAuthOf` 分流写反/写死',
    ).toHaveLength(0)
    expect(sessionsBySite.magicrewintl, '国际站的 auth 没有被调用').toHaveLength(1)
    /**
     * ③ **登录腿必须把 product 传下去**（2026-11-01 二审补的阻断级守卫）。
     *
     * `MagicrewAuth.loginViaBrowser` 里若写成 `this.browserLoginFactory({ timeoutMs })`
     * （漏 `product: this.product`），`startMagicrewBrowserLogin` 会回落
     * `options.product ?? MAGICREW` ⇒ **国际站开的是国内站登录页**，
     * 而上面两条断言**照样通过**（因为 auth 实例是对的）。
     * ⇒ 单独断言「没有一次调用漏传 product」。
     */
    expect(
      sessionsBySite['__no-product__'],
      '登录腿没把 product 传给 browserLoginFactory ⇒ 国际站会打开国内站登录页（凭据串号）',
    ).toHaveLength(0)

    release()
  })

  it('provider: magicrew（对照）时只调用国内站 auth —— 证明上面那条不是恒真', async () => {
    const { callCreate, pool, sessionsBySite, release } = await setupRpc({
      results: [CREDENTIAL],
      gate: true,
      provider: 'magicrew',
    })
    const created = await callCreate()
    expect(created.ok, `应当成功：${created.error?.message ?? ''}`).toBe(true)
    const value = created.value as { accountId: string }
    expect(pool.findAccount(value.accountId)?.provider).toBe('magicrew')
    expect(sessionsBySite.magicrew, '国内站的 auth 没有被调用').toHaveLength(1)
    expect(sessionsBySite.magicrewintl, '国内站账号误用了国际站 auth').toHaveLength(0)
    release()
  })
})

// ════════════════════════════════════════════════════════════════════════
// ⑦b `account.list` 的**昵称自愈回填**（2026-10-30）
// ════════════════════════════════════════════════════════════════════════

describe('★ account.list 的昵称自愈回填', () => {
  /**
   * ⚠️⚠️ 为什么必须有这条腿：昵称**只在登录那一刻**取一次。修复上线**之前**登录的
   * 账号，凭据里没有 `nickname` ⇒ 卡片恒显示「超级麦吉」（那是
   * `magicrewDisplayNickname` 在无 phone 时回落到 `product.displayName` 的结果）
   * ⇒ 用户必须**重新登录一次**才能看到自己的名字（真机报障 2026-10-30）。
   */
  it('★★ 登录时没取到昵称 ⇒ 下次 `account.list` 自愈回填（凭据 + 池都写），且不重复打上游', async () => {
    let mode: 'fail' | 'ok' = 'fail'
    let calls = 0
    const { callCreate, callPoll, callList, pool, store } = await setupRpc({
      results: [{ jwt: JWT_LIVE, organizationCode: 'org-cn' }],
      profileFetcher: async () => {
        if (mode === 'fail') throw new Error('HTTP 502')
        calls++
        return { nickname: 'Nick', realName: 'Nick', phone: '1380000000' }
      },
    })

    // ① 走**真实登录路径**，但资料取数失败 ⇒ 登录成功、凭据里没有 nickname
    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    await callPoll(accountId)
    const ref = pool.findAccount(accountId)!.credentialRef
    expect(store.saved(ref)?.nickname, '前提：这次登录确实没取到昵称').toBeUndefined()
    expect(pool.findAccount(accountId)?.nickname).toBe('超级麦吉')

    // ② 上游恢复 ⇒ 列表触发回填
    mode = 'ok'
    const first = await callList()
    const entry = (first.value as { accounts: { id: string, nickname?: string }[] }).accounts
      .find((a) => a.id === accountId)
    expect(entry?.nickname, '列表返回的昵称必须已是真实昵称').toBe('Nick')
    expect(store.saved(ref)?.nickname, '凭据也要写回（否则每次列表都得再取一次）').toBe('Nick')
    expect(pool.findAccount(accountId)?.nickname).toBe('Nick')
    expect(calls).toBe(1)

    // ③ 再列一次：凭据已有昵称 ⇒ 零请求
    await callList()
    expect(calls, '凭据已有昵称 ⇒ 不该再发请求').toBe(1)
  })

  it('★ 资料取数一直失败 ⇒ 列表照常 + 留痕，且每账号每进程只试一次（不每秒打上游）', async () => {
    let calls = 0
    const { callCreate, callPoll, callList, pool, warnings } = await setupRpc({
      results: [{ jwt: JWT_LIVE, organizationCode: 'org-cn' }],
      profileFetcher: async () => { calls++; throw new Error('HTTP 502') },
    })
    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    await callPoll(accountId)
    expect(calls, '登录那次已经试过').toBeGreaterThan(0)

    await callList()
    expect(warnings.join('\n')).toMatch(/读取账号资料失败/)
    const afterFirstList = calls
    await callList()
    await callList()
    expect(calls, '每账号每进程只试一次：列表再多也不该重试').toBe(afterFirstList)
    expect(pool.findAccount(accountId), '回填失败不得影响列表').toBeDefined()
  })
})

describe('sweepAbandonedMagicrewBrowserLogins（经 account.list 触发）', () => {
  it('★ 有凭据的账号**绝不**被收口（`local-browser` 建的账号也恒有凭据）', async () => {
    const { callCreate, callPoll, callList, pool } = await setupRpc({
      results: [{ jwt: JWT_LIVE, organizationCode: 'org-cn' }],
    })
    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    await callPoll(accountId)

    await callList()
    expect(pool.findAccount(accountId), '有凭据 ⇒ 那是一次成功的登录，不得删除').toBeDefined()
  })

  it('★ 让 `login.poll` 报完终态的占位条目已被删（不需要收口兜底）', async () => {
    const { callCreate, callPoll, callList, pool } = await setupRpc({ results: [undefined] })
    const created = await callCreate()
    const accountId = (created.value as { accountId: string }).accountId
    await callPoll(accountId)

    await callList()
    expect(pool.findAccount(accountId)).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
// ⑨ 客户端接线（源码级，但判据钉在「真的会被调用」上）
// ════════════════════════════════════════════════════════════════════════

describe('客户端接线：网页登录入口', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/jet-hub.js'),
    'utf8',
  )

  it('★ 弹窗把 `onBrowse` 接上（否则「网页登录」按钮点了没反应）', () => {
    // ⚠️ 判据必须打在**传参**上，不能只搜函数名 —— 函数存在但没接线是本仓库
    //    记过的经典假绿（「接线零守卫：删掉 158 条全绿」）。
    // ⚠️ 窗口从 500 放宽到 1200（2026-11-01）：加国际版后传参块前面多了
    //    `provider:` 与其长注释。**放宽的是字数上限，不是判据**——
    //    下面三条仍然逐字要求 `onBrowse` / `provider` / `onSubmit` 的真实接线。
    expect(source).toMatch(/MagicrewImportModal,\s*\{[\s\S]{0,1200}?onBrowse:/)
    // ⚠️ 2026-11-01 加国际版后 provider 变成**参数**（`credentialModal.provider`）：
    //    必须要求弹窗把 provider 显式传进去 —— 漏传会让国际站登录**静默变成国内站**
    //    （`account.create` 收到 undefined ⇒ 宿主报错或落到默认 provider）。
    expect(source).toMatch(/provider:\s*credentialModal\.provider,/)
    expect(source).toMatch(/onBrowse:\s*\(\)\s*=>\s*void submitMagicrewLocalImport\(credentialModal\.provider,\s*'browser'\)/)
    expect(source).toMatch(/function MagicrewImportModal\(\{[^}]*provider/)
    expect(source).toMatch(/function MagicrewImportModal\(\{[^}]*onBrowse/)
    // 另一条腿仍然是 `local-browser`（两条入口都得在）。
    expect(source).toMatch(/onSubmit:\s*\(\)\s*=>\s*void submitMagicrewLocalImport\(credentialModal\.provider,\s*'local-browser'\)/)
  })

  it('★ 弹窗文案按站点分流（国际站不得被指引去登国内站）', () => {
    // ⚠️ 2026-11-01 接线审查发现的真缺陷：文案写死 `www.letsmagic.cn`，而组件
    //    根本没接收 provider ⇒ 国际站用户被指引去登国内站，读取器却找
    //    `www.magicrew.ai` 的登录态 ⇒ 必然失败；宿主错误文案又反过来让他去登
    //    magicrew.ai ⇒ **引导自相矛盾的死循环**。
    expect(source).toMatch(/const isIntl = provider === 'magicrewintl'/)
    expect(source).toMatch(/www\.magicrew\.ai/)
    expect(source).toMatch(/www\.letsmagic\.cn/)
    // 且域名必须是**变量**而不是写死在文案里（写死 = 又回到那个死循环）。
    expect(source).toMatch(/`「导入」：先用 Edge \/ Chrome 打开 \$\{webHost\}/)
  })

  it('★★ 新手任务按钮的 tooltip 不得写死金额（二审：用户可见的假数字）', () => {
    // ⚠️ 2026-11-01 二审发现：该按钮对**所有** `onboardingTasks: true` 的渠道渲染
    //（loomy / raccoon / magicrew / magicrewintl），而 tooltip 原先写死
    //    「合计 10000 积分」—— 那是 **Loomy 一家**的总额。
    //    raccoon 是 3000、magicrew 由上游 `tasks[].points` 现场累加、
    //    **magicrewintl 恒为 0**（该站不把账号登记进引导计划）。
    //    ⇒ 国际站用户 hover 看到「合计 10000」、点下去「无任务可领」，
    //      与 `src/magicrew-checkin.ts` 那条「0 项不得报已全部完成」的纪律正相反。
    expect(source).not.toMatch(/领取新手任务（合计 \d+ 积分/)
    expect(source).toMatch(/领取新手任务（一次性奖励，每个账号仅能领取一次/)
  })

  it('★★ `manualRequired` 必须被前端渲染（否则宿主算出来也没人看）', () => {
    // ⚠️ 2026-11-01 测试有效性审查（重要项）：`src/types.ts` 的
    //    `RpcOnboardingClaimResponse.manualRequired` 加了但**零消费者** ——
    //    `jet-hub.js` 只渲染 `res.skipped`，于是 Magicrew 的 `first_ai_work`
    //    （服务端固定回 9303、必须真发一条消息才能置位）在用户端**完全不可见**，
    //    而单元测试只断言「字段存在」⇒ 造成「没做写成做过已修」的错觉。
    expect(source).toMatch(/const manual = Array\.isArray\(res\.manualRequired\)/)
    expect(source).toMatch(/个需你手动完成/)
    // ⚠️ 反向：它**不得**被并进 `skipped`（那个语义是「此前已完成」，
    //    把「没做」写成「已完成」就是报假账）。
    expect(source).not.toMatch(/skipped\.push\(.*manualRequired/)
  })

  it('★ 客户端发的是 mode browser（与宿主分支的字面量逐字一致）', () => {
    // ⚠️ 两种 mode 由**同一个函数**按参数分派（`submitMagicrewLocalImport(provider, mode)`）：
    //    写成两个函数就会有两份 `account.create` 调用点，也就有两份失败文案。
    expect(source).toMatch(/submitMagicrewLocalImport = async \(provider,\s*mode = 'local-browser'\)/)
    // ⚠️ 2026-11-01：provider 已参数化（原先写死 `'magicrew'`）⇒ 守「把形参原样传下去」。
    expect(source).toContain('{ provider, mode }')
    // 国际站也必须走到同一条 mode 分支（不能只为国内站判 browser）。
    expect(source).toContain("if (mode === 'browser')")
  })

  it('★★ 网页版登录复用**那一个**轮询（`startLoginPoll`），不自己写第二个循环', () => {
    // ⚠️⚠️ 这是本任务最关键的一条客户端纪律：`login-poll-terminal-failure.spec.ts`
    //    用计数守着「终态判据全文件只出现一次」。第二个 `while`/`setInterval`
    //    轮询就是第二份「先判 done 还是先判 success」的判据 ⇒ 必然漂移回 IKLI7J。
    const fn = source.slice(source.indexOf('const submitMagicrewLocalImport = async (provider'))
    const body = fn.slice(0, fn.indexOf('const createAccount'))
    // ⚠️ provider 必须**原样透传**给轮询器：写死任一站的 id 会让另一站的
    //    `login.poll` 查到错误的 provider（表现为轮询永不终态）。
    expect(body).toContain("startLoginPoll({ accountId, provider })")
    // 文件里只允许**一处** `setInterval`（就是 startLoginPoll 里那个）。
    expect((source.match(/pollRef\.current = setInterval\(/g) ?? []).length).toBe(1)
  })

  it('★★ 只允许**一份** magicrew 登录实现（两条腿按 mode 分派，不得各写一份）', () => {
    // ⚠️ 这条是**并发编辑的真实教训**：本任务期间另一路编辑在同一文件里写过第二份
    //    `submitMagicrewBrowserLogin`（自带第二个 `account.create` 调用点、且没有
    //    `accountId` 校验），而接线只指向其中一份 ⇒ 另一份成了**死代码**：
    //    「函数在、但没人调」既不会被既有守卫抓到，改错它也不会变红。
    //    ⇒ 判据：magicrew 的登录入口在全文件**只能有一个函数**（两站共用同一个）。
    expect((source.match(/const submitMagicrew\w* = async/g) ?? [])).toHaveLength(1)
    expect(source).toContain('const submitMagicrewLocalImport = async (provider')
    // 同一份语义的调用点也只能有一处（多一处就可能有一处漏校验）。
    // ⚠️ 2026-11-01：provider 参数化后不再有 `'magicrew'` 字面量 ⇒ 改为守
    //    「`account.create` 的 magicrew 系调用点恰好一处」这个**更强**的形态：
    //    写死任一站的字面量都会让这个计数变 0 而红。
    expect((source.match(/rpcCall\('account\.create', \{ provider, mode \}/g) ?? [])).toHaveLength(1)
  })

  it('★ 鼠标入口在弹窗里渲染出来（`网页登录` 这个按钮文案）', () => {
    expect(source).toContain("'网页登录'")
  })
})

/**
 * ★★ **源码层：两站串号的派生判据**（2026-11-01 二审补）。
 *
 * 这一组是**最后一道防线**：下面三种写法都不会让任何行为用例变红，
 * 但都会让国际站静默串到国内站 —— 二审实测把它们逐个注入后
 * **全量 11693 条一条不红**。
 *
 * ⚠️ 为什么用文本判据而不是行为判据：
 * - `refreshAll` 已改成行为判据（`magicrew-auth-pool.spec.ts` 的「国际站实例只续期自己的账号」）；
 * - `loginViaBrowser` 已改成行为判据（`sessionsBySite['__no-product__']`）；
 * - 但 `readLocalBrowserCreds` 走的是**模块级函数** `readMagicrewLocalCreds`
 *   （直接读真实 leveldb，不可注入）⇒ 只能退到文本判据。
 *   本组的意义是「改错就红」，不是「证明行为对」。
 */
describe('★★ 源码层：两站串号的派生判据（行为用例覆盖不到的三处）', () => {
  const authSource = readFileSync(
    new URL('../../src/magicrew-auth.ts', import.meta.url),
    'utf8',
  )

  it('★ 本机浏览器导入探测的站点来自 `this.product`（写死 MAGICREW 即红）', () => {
    // ⚠️ 实测：把 `[this.product.webOrigin, this.product.host]` 改成
    //    `[MAGICREW.webOrigin, MAGICREW.host]`，152 条相关用例全绿。
    //    生产后果：国际站实例「从本机浏览器导入」读的是 `www.letsmagic.cn` 的
    //    localStorage ⇒ 恒读不到（若用户同时登录国内站，还会把**国内凭据**
    //    导成国际账号）。
    expect(authSource).toMatch(/for \(const url of \[this\.product\.webOrigin, this\.product\.host\]\)/)
    // 反向：`localBrowserHostnames` 里不得出现裸的 `MAGICREW.` 前缀。
    const start = authSource.indexOf('private localBrowserHostnames()')
    expect(start, '找不到 localBrowserHostnames（改名了要同步改本用例）').toBeGreaterThan(-1)
    const block = authSource.slice(start, start + 600)
    expect(block, 'localBrowserHostnames 里出现了写死的 MAGICREW. 前缀').not.toMatch(/(^|[^.\w])MAGICREW\./)
  })

  it('★ 登录腿把 `product: this.product` 传给 browserLoginFactory（行为用例已另守，这里是第二道）', () => {
    expect(authSource).toMatch(/this\.browserLoginFactory\(\{ product: this\.product, timeoutMs \}\)/)
  })

  it('★ 错误文案的站点名两站都来自 product 常量（不得写死）', () => {
    // ⚠️ 二审实测：把 `magicrewIntl ? MAGICREW_INTL.displayName : MAGICREW.displayName`
    //    的国内那一支改回写死 `'超级麦吉'`，111 条相关用例全绿。
    //    今天两者恰好相等，所以看不出问题；但 `displayName` 一改就**静默分叉**
    //    （错误文案还叫旧名，用户按旧名去找不到站点）。
    const rpcSource = readFileSync(
      new URL('../../src/jet-hub-rpc.ts', import.meta.url),
      'utf8',
    )
    expect(rpcSource).toMatch(
      /const magicrewSiteName = magicrewIntl \? MAGICREW_INTL\.displayName : MAGICREW\.displayName/,
    )
  })

  /**
   * ★★ **四处 provider 判据必须两站都在场**（2026-11-01 二审）。
   *
   * 二审把这四处逐个改成「只认 `'magicrew'`」，**合计 521~380 条相关用例全绿**：
   *
   * | 位置 | 写死后的症状 |
   * |---|---|
   * | `findMagicrewAccountByFingerprint` 的 `listAccountsByProvider(provider)` | 国际站重复导入同一上游账号 ⇒ **造出重复卡片**（或改错国内卡） |
   * | `sweepAbandonedMagicrewBrowserLogins` 的 `entry.provider !== 'magicrew'` | 国际站「网页登录中途关窗」的占位条目**永久不收口** = 幽灵卡片 |
   * | `login.poll` 的在途任务判据 | 国际站登录**失败原因永远报不出来**（客户端 5 分钟超时收场） |
   * | `account.list` 昵称自愈的 `profileAuth` | 国际站自愈拿国内 auth 读国内 host ⇒ 恒 401、昵称永不回填 |
   *
   * ⚠️ 为什么是文本判据：这四处都在 `jet-hub-rpc.ts` 的内部分支里，行为级复现需要
   *    完整的 RPC 环境 + 账号池 + 在途表三者同时就位；而它们**共同的缺陷形态**
   *    就是「判据写死成一个字面量」—— 文本判据恰好对它最敏感。
   */
  it('★★ 判重 / 收口 / 轮询 / 昵称自愈 四处判据都是两站（写死单站即红）', () => {
    const rpcSource = readFileSync(
      new URL('../../src/jet-hub-rpc.ts', import.meta.url),
      'utf8',
    )
    // ① 指纹判重：按**传入的** provider 取账号，不得写死字面量。
    expect(rpcSource, '指纹判重写死了单站 provider').toMatch(
      /for \(const existing of pool\.listAccountsByProvider\(provider\)\) \{/,
    )
    // ② 幽灵条目收口：两站都要扫。
    expect(rpcSource, 'sweep 只扫了国内站（国际站幽灵卡片永久残留）').toMatch(
      /entry\.provider !== 'magicrew' && entry\.provider !== 'magicrewintl'/,
    )
    // ③ / ④ 两处 `req.provider === 'magicrew' || … === 'magicrewintl'` 的门（poll + 昵称自愈）。
    const twoSiteGates = rpcSource.match(/req\.provider === 'magicrew' \|\| req\.provider === 'magicrewintl'/g) ?? []
    expect(
      twoSiteGates.length,
      `两站门只找到 ${twoSiteGates.length} 处（应为 ≥2：login.poll 与 account.list 昵称自愈）`,
    ).toBeGreaterThanOrEqual(2)
    // ⑤ 昵称自愈的 auth 选择必须按站分流（写死 auths.magicrew 即红）。
    expect(rpcSource).toMatch(/const profileAuth = req\.provider === 'magicrewintl'/)
  })
})
