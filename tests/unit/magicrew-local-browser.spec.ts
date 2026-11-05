/**
 * magicrew-local-browser.spec.ts —— 「从本机浏览器读 magicrew 登录态」单测
 *
 * 被测源码：`src/magicrew-local-browser.ts` + `MagicrewAuth.importFromLocalBrowser` +
 * `MagicrewService.importFromLocalBrowser` + `account.create` 的 `mode: 'local-browser'` 分支。
 *
 * ── ⚠️⚠️ 硬约束：**绝不读用户真实浏览器数据** ─────────────────────────────
 * 浏览器 localStorage 里的内容是**真实登录态**（读到就能当用户用），而且随开发机
 * 而变 —— 扫真实目录会让用例「在本机绿、在 CI 红」，还会把用户凭据读进测试进程。
 *
 * ⇒ 全部用例都走注入：
 * - 纯函数级：直接喂字符串，零文件系统；
 * - `readMagicrewLocalCreds`：`options.roots` 指 `mkdtempSync` 出来的临时 User Data；
 * - `MagicrewAuth`：`MagicrewAuthOptions.browserRoots` 指同一个临时目录；
 * - `MagicrewService` / `account.create`：同上，且 `fetchImpl` 是假 fetch
 *   （签发 `mgw_` key 那一步，**永远不打** `i-magic-service.letsmagic.cn`）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { MagicrewAuth } from '../../src/magicrew-auth.js'
import {
  credsNear,
  jwtTimes,
  leveldbTextFor,
  magicrewBrowserRoots,
  readMagicrewLocalCreds,
} from '../../src/magicrew-local-browser.js'
import { MAGICREW, MAGICREW_GATEWAY_TOKENS_PATH } from '../../src/magicrew-product.js'
import type { MagicrewProduct } from '../../src/magicrew-product.js'
import { registeredBrowserUserDataRoots } from '../../src/chromium-session.js'
import { MAGICREW_PROFILE_PATH, type MagicrewProfile } from '../../src/magicrew-profile.js'
import { MagicrewService } from '../../src/magicrew.js'

// ════════════════════════════════════════════════════════════════════════
// fixture 原语
// ════════════════════════════════════════════════════════════════════════

/** 固定时钟：过期/未过期的判据不依赖真实时间（否则用例是日期炸弹）。 */
const NOW = 1_800_000_000_000

/** 本机实测的那两个 origin（网页在 `www`，API 在 `i-magic-service`）。 */
const ORIGIN_CN = 'https://www.letsmagic.cn'
const ORIGIN_INTL = 'https://www.magicrew.ai'

/** 造一把形状合法的 JWT（只关心 `iat` / `exp`，签名段是假的）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fixture-signature`
}

/** 未过期（`exp` = NOW + 1h）。 */
const JWT_LIVE = makeJwt({ iat: Math.floor(NOW / 1000) - 60, exp: Math.floor(NOW / 1000) + 3600 })
/** 已过期（`exp` = NOW - 1h）。 */
const JWT_EXPIRED = makeJwt({ iat: Math.floor(NOW / 1000) - 7200, exp: Math.floor(NOW / 1000) - 3600 })

/**
 * 一条 localStorage 记录的 leveldb 形态：`_<origin>\x00\x01<name>` 前缀 + 值。
 *
 * ⚠️ 真实 leveldb 里 key 与 value 是二进制相邻的；这里用 latin1 可读的拼接近似
 * （被测代码也只按 latin1 文本 + host 窗口找，不解析 leveldb 格式）。
 */
function storageEntry(origin: string, name: string, value: string): string {
  return `_${origin}\u0000\u0001${name}\u0000\u0001${value}`
}

/** 一对 `authorization` × `organizationCode` 的 JSON（与 magpie 侧实测形态一致）。 */
function credentialPair(jwt: string, organizationCode: string): string {
  return `{"key":"authorization","value":"${jwt}"}`
    + `{"key":"organizationCode","value":"${organizationCode}"}`
}

/** 把一个 leveldb 文本写进临时 User Data 根目录（`Default` profile）。 */
function makeUserData(text: string, profile = 'Default'): string {
  const root = mkdtempSync(join(tmpdir(), 'magicrew-browser-fixture-'))
  const dir = join(root, profile, 'Local Storage', 'leveldb')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '000003.log'), Buffer.from(text, 'latin1'))
  return root
}

/** 最小内存凭据库（形状与宿主 `ctx.credentials` 一致：**值是字符串**）。 */
class FakeStore {
  readonly values = new Map<string, string>()
  readonly setCalls: string[] = []

  seed(refName: string, value: string): void {
    this.values.set(refName, value)
  }

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 签发 `mgw_` key 的上游信封（`code:1000` = ok）。
 *
 * ⚠️ `withExpiry: false` 给出**真机凭据的那种形状**（2026-10-29）：只有
 * `api_key` / `refresh_token`，**没有任何到期时刻** —— 真机 `~/.dsh/.credentials.yaml`
 * 实测如此，而这正是卡片显示「有效期 未知」的那一格。
 *
 * ⚠️ 值只能走**默认参数**、不要在调用处再写一遍字面量：本仓有 PII 守卫
 * （`tests/unit/repo-pii-guard.spec.ts` 的「凭据字段名 + 高熵字面量」），
 * `api_key: '<16 位以上字面量>'` 会被判成疑似真实凭据。
 */
function keyEnvelope(
  apiKey = 'mgw_from-browser',
  refreshToken = 'rt_from-browser',
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

// ════════════════════════════════════════════════════════════════════════
// ① 纯函数：credsNear / jwtTimes / leveldbTextFor
// ════════════════════════════════════════════════════════════════════════

describe('credsNear：窗口内配对 authorization × organizationCode', () => {
  it('★ 从一段带干扰项的 leveldb 文本里取出唯一一对（不串到另一个站点）', () => {
    const text = [
      storageEntry(ORIGIN_CN, 'theme', '{"mode":"dark"}'),
      storageEntry(ORIGIN_CN, 'magicrew-store', credentialPair(JWT_LIVE, 'org-cn')),
      storageEntry(ORIGIN_CN, 'i18n', '{"lang":"zh"}'),
      // ⚠️ 干扰项：另一个站点**紧挨着**，它的 org 绝不能被配到上面的 jwt 上。
      storageEntry(ORIGIN_INTL, 'magicrew-store', credentialPair(JWT_EXPIRED, 'org-intl')),
    ].join('\n')

    expect(credsNear(text, 'www.letsmagic.cn')).toEqual([
      { jwt: JWT_LIVE, organizationCode: 'org-cn' },
    ])
    expect(credsNear(text, 'www.magicrew.ai')).toEqual([
      { jwt: JWT_EXPIRED, organizationCode: 'org-intl' },
    ])
  })

  it('★ 同一站点有两套凭据时，每把 jwt 配**它自己后面**最近的组织码', () => {
    const second = makeJwt({ iat: Math.floor(NOW / 1000) - 10, exp: Math.floor(NOW / 1000) + 60 })
    const text = [
      storageEntry(ORIGIN_CN, 'a', credentialPair(JWT_LIVE, 'org-old')),
      storageEntry(ORIGIN_CN, 'b', credentialPair(second, 'org-new')),
    ].join('\n')

    // ⚠️ 取「窗口内第一个 org」会把两把 jwt 都配成 org-old —— 那正是上游会回
    //    HTTP 200 + `code:403` 的错配，且极难归因。
    expect(credsNear(text, 'www.letsmagic.cn')).toEqual([
      { jwt: JWT_LIVE, organizationCode: 'org-old' },
      { jwt: second, organizationCode: 'org-new' },
    ])
  })

  it('⚠️ 窗口内只有 authorization 没有 organizationCode ⇒ 空数组（不编造空串）', () => {
    const text = [
      storageEntry(ORIGIN_CN, 'x', `{"key":"authorization","value":"${JWT_LIVE}"}`),
      // org 属于**另一个**站点且在截断点之后 ⇒ 不可见。
      storageEntry(ORIGIN_INTL, 'x', '{"key":"organizationCode","value":"org-intl"}'),
    ].join('\n')

    expect(credsNear(text, 'www.letsmagic.cn')).toEqual([])
  })

  it('识别被二次转义（`\\"`）的记录形态', () => {
    const text = [
      storageEntry(
        ORIGIN_CN,
        'double-escaped',
        `{\\"key\\":\\"authorization\\",\\"value\\":\\"${JWT_LIVE}\\"}`
          + `{\\"key\\":\\"organizationCode\\",\\"value\\":\\"org-escaped\\"}`,
      ),
    ].join('\n')

    expect(credsNear(text, 'www.letsmagic.cn')).toEqual([
      { jwt: JWT_LIVE, organizationCode: 'org-escaped' },
    ])
  })

  it('host 去 `www.` 后同样命中（`letsmagic.cn` / `www.letsmagic.cn` 两种写法）', () => {
    const text = storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn'))
    expect(credsNear(text, 'letsmagic.cn')).toHaveLength(1)
    expect(credsNear(text, 'www.letsmagic.cn')).toHaveLength(1)
    expect(credsNear(text, '')).toEqual([])
  })
})

describe('jwtTimes', () => {
  it('解出 iat / exp（秒）', () => {
    expect(jwtTimes(JWT_LIVE)).toEqual({
      iat: Math.floor(NOW / 1000) - 60,
      exp: Math.floor(NOW / 1000) + 3600,
    })
  })

  it('坏 jwt（非 JWT / 空串）⇒ 0/0，不抛错', () => {
    expect(jwtTimes('')).toEqual({ iat: 0, exp: 0 })
    expect(jwtTimes('not-a-jwt')).toEqual({ iat: 0, exp: 0 })
    expect(jwtTimes('a.!!!not-base64!!!.c')).toEqual({ iat: 0, exp: 0 })
  })
})

describe('magicrewBrowserRoots / leveldbTextFor', () => {
  it('根目录列表非空，且**不含** magpie 自己的目录', () => {
    const roots = magicrewBrowserRoots()
    expect(roots.length).toBeGreaterThan(0)
    expect(roots.every((entry) => entry.root.length > 0 && entry.browser.length > 0)).toBe(true)
    // ⚠️ 参考实现与 magpie 同仓，但本插件**不读** `~/.config/magpie`（那是另一个产品的目录）。
    expect(roots.map((entry) => entry.root)).not.toContain(join(
      process.env.HOME ?? process.env.USERPROFILE ?? '', '.config', 'magpie',
    ))
    expect(roots.every((entry) => !entry.root.includes('magpie'))).toBe(true)
  })

  it('★ 可通过环境变量发现便携版 Chrome 的 User Data（不再漏掉已登录态）', () => {
    const root = join(tmpdir(), 'portable-chrome-user-data')
    vi.stubEnv('MAGICREW_CHROME_USER_DATA', root)
    try {
      expect(magicrewBrowserRoots()).toContainEqual({ browser: 'Chrome 便携版', root })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('★ 环境变量**带空格**也要 trim（否则拼出带空格的路径 ⇒ 读不到）', () => {
    // ⚠️ 旧实现用 `process.env.X?.trim()` 判空但**拼接时用原值**
    //    ⇒ `MAGICREW_CHROME_USER_DATA='  D:\x  '` 会拼出带空格的路径。
    const root = join(tmpdir(), 'portable-chrome-user-data-trim')
    vi.stubEnv('MAGICREW_CHROME_USER_DATA', `  ${root}  `)
    try {
      const roots = magicrewBrowserRoots()
      expect(roots).toContainEqual({ browser: 'Chrome 便携版', root })
      // ⚠️ 反向对照：**不得**出现带空格的形态
      expect(roots.map((entry) => entry.root)).not.toContain(`  ${root}  `)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('★ 环境变量**为空串/纯空格** ⇒ 不产生候选', () => {
    for (const value of ['', '   ']) {
      vi.stubEnv('MAGICREW_CHROME_USER_DATA', value)
      try {
        expect(magicrewBrowserRoots().map((e) => e.browser))
          .not.toContain('Chrome 便携版')
      } finally {
        vi.unstubAllEnvs()
      }
    }
  })

  it('★★ 便携版的 `<install>/Data` 必须是候选根（2026-10-30 审计 P1 D-03 修）', () => {
    // ⚠️⚠️ **这是 PR !162 的核心修复**，而旧守卫**零覆盖**
    //    （删掉 `join(install,'Data')` ⇒ 146 条全绿）。
    // ⇒ 这里**直接测 `registeredBrowserUserDataRoots`**：
    //    造一个「便携版布局」的真实目录树，断言它被认出来。
    const dir = mkdtempSync(join(tmpdir(), 'portable-layout-'))
    try {
      // ⚠️ 布局 A：`<install>/App/chrome.exe` + `<install>/Data/Default/...`
      const install = join(dir, 'Chrome')
      const exe = join(install, 'App', 'chrome.exe')
      mkdirSync(dirname(exe), { recursive: true })
      writeFileSync(exe, '')
      mkdirSync(join(install, 'Data', 'Default'), { recursive: true })

      const roots = registeredBrowserUserDataRoots([exe])
      expect(roots, '便携版的 Data 根必须被认出来').toContain(join(install, 'Data'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★★ 布局 B：`<install>/chrome.exe`（exe 直接在安装根）也要认出来（2026-10-30 审计 P0 D-02 修）', () => {
    // ⚠️ 旧实现用 `dirname(dirname(exe))` **硬编码两级** ⇒ 布局 B 会**高一级**
    //    ⇒ 拼出 `<父级>/Data` ⇒ 永远读不到。
    const dir = mkdtempSync(join(tmpdir(), 'portable-layout-b-'))
    try {
      const install = join(dir, 'Chrome')
      const exe = join(install, 'chrome.exe')
      mkdirSync(install, { recursive: true })
      writeFileSync(exe, '')
      mkdirSync(join(install, 'Data', 'Default'), { recursive: true })

      const roots = registeredBrowserUserDataRoots([exe])
      expect(roots, '布局 B 的 Data 根必须被认出来').toContain(join(install, 'Data'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★★ 目录**不存在** ⇒ 不产生候选（存在性过滤，2026-10-30 审计 P2-1 修）', () => {
    // ⚠️ 标准安装会推出 `C:\Program Files\Google\Data` 这种垃圾路径 ⇒
    //    存在性过滤把它筛掉（否则污染目录列表 + 扫无关目录的 localStorage）。
    const dir = mkdtempSync(join(tmpdir(), 'portable-nodata-'))
    try {
      const exe = join(dir, 'App', 'chrome.exe')
      mkdirSync(dirname(exe), { recursive: true })
      writeFileSync(exe, '')
      // ⚠️ **没有** `Data`、也没有 `User Data` ⇒ 不该有任何根
      expect(registeredBrowserUserDataRoots([exe])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ 多 profile 的文本都要读到，且**用 \\n 隔开**（否则尾部与头部会拼出假记录）', () => {
    const root = mkdtempSync(join(tmpdir(), 'magicrew-browser-profiles-'))
    const write = (profile: string, text: string) => {
      const dir = join(root, profile, 'Local Storage', 'leveldb')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '000003.log'), Buffer.from(text, 'latin1'))
    }
    write('Default', 'PROFILE_DEFAULT')
    write('Profile 1', 'PROFILE_ONE')
    // 非 profile 目录必须被忽略
    mkdirSync(join(root, 'Crashpad'), { recursive: true })

    const text = leveldbTextFor(root)
    expect(text).toContain('PROFILE_DEFAULT')
    expect(text).toContain('PROFILE_ONE')
    expect(text.indexOf('PROFILE_DEFAULT')).toBeLessThan(text.indexOf('PROFILE_ONE'))
    // ⚠️ 分隔符：两个 profile 直接相接会造出不存在的记录（见函数注释）。
    expect(text).toContain('PROFILE_DEFAULT\nPROFILE_ONE')
  })

  it('根目录不存在 ⇒ 空串（不抛错）', () => {
    expect(leveldbTextFor(join(tmpdir(), 'magicrew-browser-does-not-exist'))).toBe('')
  })
})

// ════════════════════════════════════════════════════════════════════════
// ② readMagicrewLocalCreds：临时目录注入（绝不碰真实浏览器）
// ════════════════════════════════════════════════════════════════════════

describe('readMagicrewLocalCreds（roots 注入，零真实浏览器数据）', () => {
  function userData(text: string): string {
    return makeUserData(text)
  }

  it('★ 从临时 User Data 里读出 jwt / organizationCode / expiresAt', () => {
    const root = userData(storageEntry(ORIGIN_CN, 'magicrew-store', credentialPair(JWT_LIVE, 'org-cn')))

    const found = readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW })
    expect(found).toEqual({
      jwt: JWT_LIVE,
      organizationCode: 'org-cn',
      expiresAt: (Math.floor(NOW / 1000) + 3600) * 1000,
    })
  })

  it('⚠️ 过期的凭据**照样返回**（过期由调用方判，不在这里拦）', () => {
    const root = userData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_EXPIRED, 'org-cn')))

    const found = readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW })
    expect(found, '过期不是「读不到」—— 拦掉会白丢 refresh_token 这条自救路径').toBeDefined()
    expect(found?.jwt).toBe(JWT_EXPIRED)
    expect(found?.expiresAt).toBe((Math.floor(NOW / 1000) - 3600) * 1000)
  })

  it('⚠️ 窗口内只有 authorization ⇒ undefined（不编造空 organizationCode）', () => {
    const root = userData(
      // 只有 jwt；org 属于另一个站点，且在截断点之外。
      storageEntry(ORIGIN_CN, 'x', `{"key":"authorization","value":"${JWT_LIVE}"}`)
        + storageEntry(ORIGIN_INTL, 'x', '{"key":"organizationCode","value":"org-intl"}'),
    )

    expect(readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW })).toBeUndefined()
  })

  it('同时有新旧两套时优先未过期的那套', () => {
    const fresh = makeJwt({ iat: Math.floor(NOW / 1000) - 5, exp: Math.floor(NOW / 1000) + 60 })
    const root = userData([
      storageEntry(ORIGIN_CN, 'a', credentialPair(JWT_EXPIRED, 'org-old')),
      storageEntry(ORIGIN_CN, 'b', credentialPair(fresh, 'org-new')),
    ].join('\n'))

    expect(readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW })?.organizationCode)
      .toBe('org-new')
  })

  it('注入 `roots: []` ⇒ 立即 undefined（证明注入真的生效、不会回落到真实目录）', () => {
    expect(readMagicrewLocalCreds('www.letsmagic.cn', { roots: [], now: NOW })).toBeUndefined()
  })

  it('空 hostname ⇒ undefined（不扫任何目录）', () => {
    const root = userData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    expect(readMagicrewLocalCreds('   ', { roots: [root], now: NOW })).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
// ③ MagicrewAuth.importFromLocalBrowser
// ════════════════════════════════════════════════════════════════════════

function makeContext(store: FakeStore): Context {
  const ctx = new Context()
  ctx.provide('credentials', store as never)
  return ctx
}

describe('MagicrewAuth.importFromLocalBrowser（browserRoots 注入）', () => {
  it('★ 读到登录态 ⇒ 签发一次 key、写进 `defaultCredentialRef`、返回凭据', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const store = new FakeStore()
    const calls: { url: string, method: string, authorization: string }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init.method),
        authorization: String((init.headers as Record<string, string>).authorization),
      })
      return keyEnvelope()
    }) as unknown as typeof fetch

    const auth = new MagicrewAuth(makeContext(store), {
      store, browserRoots: [root], fetchImpl,
    })
    const credential = await auth.importFromLocalBrowser()

    expect(credential, '本机有登录态时必须返回凭据').toBeDefined()
    expect(credential?.jwt).toBe(JWT_LIVE)
    expect(credential?.organizationCode).toBe('org-cn')
    expect(credential?.apiKey).toBe('mgw_from-browser')
    expect(credential?.refreshToken).toBe('rt_from-browser')

    // 签发确实发生了（**一次**，且用的是刚读到的 jwt）—— 否则池里会多一个
    // 「有账号、每请求抛 AUTH」的幽灵条目。
    //
    // ⚠️ 2026-10-29 起这条腿会**再发一次**请求（取账号资料 / 昵称，见
    //    `MagicrewAuth.withProfileNickname`）⇒ 判据按 URL 分开数：
    //    「签发恰好一次」这条守卫的牙齿不能因为多了一条腿而消失。
    const keyCalls = calls.filter((call) => call.url.includes(MAGICREW_GATEWAY_TOKENS_PATH))
    expect(keyCalls).toHaveLength(1)
    expect(keyCalls[0]?.url).toBe(`${MAGICREW.host}${MAGICREW_GATEWAY_TOKENS_PATH}`)
    expect(keyCalls[0]?.method).toBe('POST')
    expect(keyCalls[0]?.authorization).toBe(`Bearer ${JWT_LIVE}`)
    // 其余调用只允许是资料端点（多发第三个请求 = 登录被偷偷加长）。
    expect(calls.map((call) => call.url).filter((url) => !url.includes(MAGICREW_GATEWAY_TOKENS_PATH)))
      .toEqual([`${MAGICREW.host}${MAGICREW_PROFILE_PATH}`])

    // 凭据落在 `defaultCredentialRef`，且是**序列化后的字符串**（宿主只收字符串）。
    const saved = store.saved(MAGICREW.defaultCredentialRef)
    expect(saved?.jwt).toBe(JWT_LIVE)
    expect(saved?.organizationCode).toBe('org-cn')
    expect(saved?.apiKey).toBe('mgw_from-browser')
  })

  it('⚠️ 读不到 ⇒ undefined，且**零网络、零写入**（不留幽灵账号）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_INTL, 'x', credentialPair(JWT_LIVE, 'org-intl')))
    const store = new FakeStore()
    const fetchImpl = vi.fn(async () => keyEnvelope()) as unknown as typeof fetch

    const auth = new MagicrewAuth(makeContext(store), {
      store, browserRoots: [root], fetchImpl,
    })
    expect(await auth.importFromLocalBrowser()).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.setCalls).toEqual([])
  })

  it('⚠️ 签发失败**不吞掉**导入结果，但必须 warn（不许静默）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const store = new FakeStore()
    const warnings: string[] = []
    const fetchImpl = (async () => {
      throw new Error('gateway down')
    }) as unknown as typeof fetch

    const auth = new MagicrewAuth(makeContext(store), {
      store, browserRoots: [root], fetchImpl, warn: (message) => warnings.push(message),
    })
    const credential = await auth.importFromLocalBrowser()

    expect(credential, 'jwt 能拉目录/积分 ⇒ 不许因为签发失败就丢掉整个结果').toBeDefined()
    expect(credential?.jwt).toBe(JWT_LIVE)
    expect(credential?.organizationCode).toBe('org-cn')
    expect(credential?.apiKey).toBeUndefined()
    expect(warnings.join('\n'), '签发失败是唯一线索，不许静默').toMatch(/签发 gateway key 失败/)
    // 仍然落库（只有 jwt 的凭据也能救回来）。
    expect(store.saved(MAGICREW.defaultCredentialRef)?.jwt).toBe(JWT_LIVE)
  })

  it('★ 网页 origin 优先于 API host（localStorage 的 key 是网页 origin）', async () => {
    // 两个 origin 各有一份**不同**的凭据：只按 `product.host` 找会读不到（恒静默）。
    const apiOrigin = new URL(MAGICREW.host).origin
    const root = makeUserData([
      storageEntry(ORIGIN_CN, 'web', credentialPair(JWT_LIVE, 'org-web')),
      storageEntry(apiOrigin, 'api', credentialPair(JWT_EXPIRED, 'org-api')),
    ].join('\n'))

    const auth = new MagicrewAuth(makeContext(new FakeStore()), {
      store: new FakeStore(),
      browserRoots: [root],
      fetchImpl: (async () => keyEnvelope()) as unknown as typeof fetch,
    })
    expect((await auth.importFromLocalBrowser())?.organizationCode).toBe('org-web')
  })

  it('★★ 登录时取到昵称 ⇒ 写进凭据（浏览器登录的凭据没有 phone，昵称是唯一展示名）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const store = new FakeStore()
    const asked: { jwt: string, organizationCode: string }[] = []

    const auth = new MagicrewAuth(makeContext(store), {
      store,
      browserRoots: [root],
      fetchImpl: (async () => keyEnvelope()) as unknown as typeof fetch,
      profileFetcher: async (params) => {
        asked.push({ jwt: params.jwt, organizationCode: params.organizationCode })
        return { nickname: 'Nick', realName: 'Nick', phone: '1380000000' }
      },
    })
    const credential = await auth.importFromLocalBrowser()

    expect(credential?.nickname, '昵称必须进凭据，否则卡片仍显示「超级麦吉」').toBe('Nick')
    // ⚠️ 取资料用的必须是**刚读到的那把 jwt + 它的组织码**（错配会拿到别人的资料）。
    expect(asked).toEqual([{ jwt: JWT_LIVE, organizationCode: 'org-cn' }])
    // 落库也要带上（否则重启后又变回渠道名）。
    expect(store.saved(MAGICREW.defaultCredentialRef)?.nickname).toBe('Nick')
    // 昵称不进 `phone`（上游那个是 10 位本地号，塞进 11 位脱敏判据会得到错位掩码）。
    expect(store.saved(MAGICREW.defaultCredentialRef)?.phone).toBeUndefined()
  })

  it('★★ 取昵称失败 ⇒ **不挡登录**，但必须 warn 留痕（不许静默）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const store = new FakeStore()
    const warnings: string[] = []

    const auth = new MagicrewAuth(makeContext(store), {
      store,
      browserRoots: [root],
      fetchImpl: (async () => keyEnvelope()) as unknown as typeof fetch,
      warn: (message) => warnings.push(message),
      profileFetcher: async () => { throw new Error('HTTP 500') },
    })
    const credential = await auth.importFromLocalBrowser()

    expect(credential, '昵称只是展示名，取不到不该让登录失败').toBeDefined()
    expect(credential?.jwt).toBe(JWT_LIVE)
    expect(credential?.apiKey, '网关 key 那条腿不受影响').toBe('mgw_from-browser')
    expect(credential?.nickname).toBeUndefined()
    expect(warnings.join('\n')).toMatch(/读取账号资料失败/)
    // ⚠️ 仍然落库（只有 jwt / 无昵称的凭据照常可用）。
    expect(store.saved(MAGICREW.defaultCredentialRef)?.jwt).toBe(JWT_LIVE)
  })

  it('⚠️ 取到了资料但**里面没有昵称** ⇒ 同样留痕（否则与「压根没调」不可区分）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const store = new FakeStore()
    const warnings: string[] = []

    const auth = new MagicrewAuth(makeContext(store), {
      store,
      browserRoots: [root],
      fetchImpl: (async () => keyEnvelope()) as unknown as typeof fetch,
      warn: (message) => warnings.push(message),
      profileFetcher: async () => ({ nickname: '  ', realName: '', phone: '1380000000' }),
    })
    const credential = await auth.importFromLocalBrowser()

    expect(credential?.nickname).toBeUndefined()
    expect(warnings.join('\n')).toMatch(/没有昵称/)
  })
})

// ════════════════════════════════════════════════════════════════════════
// ④ MagicrewService：薄委托
// ════════════════════════════════════════════════════════════════════════

describe('MagicrewService.importFromLocalBrowser', () => {
  it('★ 薄委托到 auth（读到什么就返回什么）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const auth = new MagicrewAuth(makeContext(new FakeStore()), {
      store: new FakeStore(),
      browserRoots: [root],
      fetchImpl: (async () => keyEnvelope()) as unknown as typeof fetch,
    })
    const service = new MagicrewService({ auth })
    const credential = await service.importFromLocalBrowser()
    expect(credential?.organizationCode).toBe('org-cn')
  })

  it('未注入 auth ⇒ **抛错**（不把装配缺陷伪装成「本机没登录态」）', async () => {
    const service = new MagicrewService({})
    await expect(service.importFromLocalBrowser()).rejects.toThrow(/未注入 `auth`/)
  })
})

// ════════════════════════════════════════════════════════════════════════
// ⑤ RPC `account.create` 的 `mode: 'local-browser'` 分支（真跑 handler）
// ════════════════════════════════════════════════════════════════════════

/**
 * 搭一个能跑 `account.create` 的最小环境：真实 `AccountPool` + 真实 RPC handler +
 * 真实 `MagicrewAuth`（只注入 `browserRoots` 与假 `fetchImpl`）。
 *
 * ⚠️ 两个注入点是 2026-10-29 加的（昵称 / 有效期两条腿）：
 * - `profileFetcher` —— 假资料取数器（真取数器已由 `magicrew-profile.spec.ts` 覆盖）；
 * - `keyEnvelope` —— 可换一封**不带 `api_key_expires_at`** 的网关信封，用来钉住
 *   「有效期回落 JWT exp」那条腿（真机上浏览器登录的凭据就是这种形状）。
 */
async function setupRpc(userDataRoot: string, options: {
  profileFetcher?: (params: {
    jwt: string
    organizationCode: string
    product: MagicrewProduct
  }) => Promise<MagicrewProfile>
  keyEnvelope?: () => Response
} = {}) {
  let stored: Record<string, unknown> = { accounts: [], disabledModels: {} }
  const ctx = new Context() as never as {
    provide: (name: string, value: unknown) => void
    get: (name: string) => unknown
  }
  const store = new FakeStore()
  const credentials = store as unknown as {
    resolve: (ref: unknown) => Promise<{ value: string } | undefined>
    set: (ref: unknown, value: string) => Promise<void>
    unset: (ref: unknown) => Promise<void>
  }
  ctx.provide('credentials', credentials)
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
  ctx.provide('accountPool', pool)

  const magicrewAuth = new MagicrewAuth(ctx as never, {
    store,
    browserRoots: [userDataRoot],
    fetchImpl: (async () => (options.keyEnvelope ?? keyEnvelope)()) as unknown as typeof fetch,
    ...options.profileFetcher === undefined ? {} : { profileFetcher: options.profileFetcher },
  })

  let handler: ((req: Request) => Promise<Response>) | undefined
  const rpcCtx = {
    // ⚠️ handler 内部是**直接用 `ctx.credentials` 属性**的（不是 `ctx.get(...)`），
    //    只实现 `get` 会让 `ctx.credentials.set` 抛 `Cannot read properties of undefined`。
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
    codearts: {}, buddy: {}, workbuddy: {}, lobsterai: {}, qoder: {}, qodercn: {},
    trae: {}, cline: {}, loomy: {}, raccoon: {}, minimax: {}, zcode: {},
    gemini: {}, officeace: {}, minimaxintl: {}, autoclaw: {}, accio: {},
    opencode: {},
  } as never)
  if (handler === undefined) throw new Error('RPC handler 未注册')

  return {
    pool,
    store,
    call: async (payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'r1', method: 'jet-hub',
          payload: { method: 'account.create', payload },
        }),
      }))
      const body = await response.json() as {
        result: { ok: boolean, value?: unknown, error?: { message: string } }
      }
      return body.result
    },
  }
}

describe("★ account.create({ provider: 'magicrew', mode: 'local-browser' })", () => {
  it('★ 读到登录态 ⇒ 建账号、返回 accountId + 空 loginUrl', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const { call, pool } = await setupRpc(root)

    const created = await call({ provider: 'magicrew', mode: 'local-browser' })
    expect(created.ok, `应当成功：${created.error?.message ?? ''}`).toBe(true)
    const value = created.value as { accountId: string, loginUrl: string }
    expect(value.loginUrl, '不开窗口 ⇒ loginUrl 必须是空串').toBe('')
    expect(pool.findAccount(value.accountId), '账号必须真实写进池').toBeDefined()

    const account = pool.findAccount(value.accountId)
    expect(account?.provider).toBe('magicrew')
    expect(account?.expiresAt).toBe(NOW + 7200_000)
    // 凭据写在该账号自己的 ref 上（不是只写 default ref）。
    const saved = pool.readAccounts().find((entry) => entry.id === value.accountId)
    expect(saved?.credentialRef).toMatch(/^MAGICREW_ACCOUNT_/)
  })

  it('★★ 幂等：同一份凭据反复导入**不造第二个账号**', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const { call, pool } = await setupRpc(root)

    const first = await call({ provider: 'magicrew', mode: 'local-browser' })
    const second = await call({ provider: 'magicrew', mode: 'local-browser' })
    expect(first.ok && second.ok).toBe(true)
    const firstId = (first.value as { accountId: string }).accountId
    const secondId = (second.value as { accountId: string }).accountId

    expect(secondId, '同一份凭据（同一账号）必须复用原账号 id').toBe(firstId)
    expect(
      pool.listAccountsByProvider('magicrew'),
      '反复导入不得造出多个账号（用户看到的是重复卡片 + 积分重复）',
    ).toHaveLength(1)
  })

  it('⚠️ 本机没有登录态 ⇒ ok:false + 可读文案，且**不建账号**', async () => {
    const root = makeUserData(storageEntry(ORIGIN_INTL, 'x', credentialPair(JWT_LIVE, 'org-intl')))
    const { call, pool } = await setupRpc(root)

    const created = await call({ provider: 'magicrew', mode: 'local-browser' })
    expect(created.ok).toBe(false)
    expect(created.error?.message ?? '').toContain('未在本机浏览器里找到超级麦吉的登录态')
    expect(pool.listAccountsByProvider('magicrew')).toHaveLength(0)
  })

  it('⚠️ 既有分支未被改动：不带 mode 时仍走手机号密码校验（缺手机号即 bad-request）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const { call, pool } = await setupRpc(root)

    const created = await call({ provider: 'magicrew' })
    expect(created.ok).toBe(false)
    expect(created.error?.message ?? '').toContain('手机号')
    expect(pool.listAccountsByProvider('magicrew')).toHaveLength(0)
  })

  it('★★ 卡片昵称取**上游真实昵称**（不再是「超级麦吉」）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const { call, pool } = await setupRpc(root, {
      profileFetcher: async () => ({ nickname: 'Nick', realName: 'Nick', phone: '1380000000' }),
    })

    const created = await call({ provider: 'magicrew', mode: 'local-browser' })
    const accountId = (created.value as { accountId: string }).accountId
    expect(pool.findAccount(accountId)?.nickname).toBe('Nick')
  })

  it('★★ 幂等命中时连昵称一起刷新（同一个 id、仍然只有一条）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    let nick = 'Nick'
    const { call, pool } = await setupRpc(root, {
      profileFetcher: async () => ({ nickname: nick, realName: nick, phone: '' }),
    })

    const first = await call({ provider: 'magicrew', mode: 'local-browser' })
    const firstId = (first.value as { accountId: string }).accountId
    nick = 'Jet 改名了'
    const second = await call({ provider: 'magicrew', mode: 'local-browser' })

    expect((second.value as { accountId: string }).accountId).toBe(firstId)
    expect(pool.listAccountsByProvider('magicrew')).toHaveLength(1)
    expect(pool.findAccount(firstId)?.nickname).toBe('Jet 改名了')
  })

  it('★★ 凭据没有 `api_key_expires_at` ⇒ 卡片有效期取 **JWT 的 exp**（真机那张「未知」卡片走的就是这一格）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const { call, pool } = await setupRpc(root, {
      // 与真机凭据同形：只有 api_key / refresh_token，**没有**到期时刻。
      keyEnvelope: () => keyEnvelope(undefined, undefined, false),
    })

    const created = await call({ provider: 'magicrew', mode: 'local-browser' })
    const accountId = (created.value as { accountId: string }).accountId
    // `JWT_LIVE.exp` 是**秒** ⇒ 卡片用的是毫秒（差 1000 倍会让卡片显示 1970 年）。
    expect(pool.findAccount(accountId)?.expiresAt).toBe((Math.floor(NOW / 1000) + 3600) * 1000)
  })

  it('★★ 池里已有**同一份凭据**（哪怕它的 ref 是默认 ref）⇒ 复用那一条，不新建', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const { call, pool, store } = await setupRpc(root)

    /**
     * ⚠️ 这条用例钉的是「**ref 名不参与判据**」：`importFromLocalBrowser` 会把凭据写到
     * `defaultCredentialRef`（`MAGICREW_ACCESS_TOKEN`，与 `ASTUDIO_ACCESS_TOKEN` /
     * `CODEARTS_ACCESS_TOKEN` 同惯例），若池里那条账号用的就是它，**照样算同一个账号**。
     */
    const seededRef = MAGICREW.defaultCredentialRef
    store.seed(seededRef, JSON.stringify({ jwt: JWT_LIVE, organizationCode: 'org-cn' }))
    await pool.addAccount({
      id: 'magicrew-existing', provider: 'magicrew', nickname: '旧的',
      enabled: true, credentialRef: seededRef, refreshable: true, createdAt: 0,
    })

    const created = await call({ provider: 'magicrew', mode: 'local-browser' })
    expect((created.value as { accountId: string }).accountId).toBe('magicrew-existing')
    expect(pool.listAccountsByProvider('magicrew'), '不能因为 ref 名不同就当成两个账号').toHaveLength(1)
  })

  it('★ 反向对照：**不同**凭据 ⇒ 老老实实建第二条（否则「凡创建都复用」也会全绿）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const { call, pool, store } = await setupRpc(root)

    const otherJwt = makeJwt({ iat: Math.floor(NOW / 1000) - 120, exp: Math.floor(NOW / 1000) + 3600 })
    store.seed('MAGICREW_ACCOUNT_OTHER', JSON.stringify({ jwt: otherJwt, organizationCode: 'org-cn' }))
    await pool.addAccount({
      id: 'magicrew-other', provider: 'magicrew', nickname: '别的号',
      enabled: true, credentialRef: 'MAGICREW_ACCOUNT_OTHER', refreshable: true, createdAt: 0,
    })

    const created = await call({ provider: 'magicrew', mode: 'local-browser' })
    expect((created.value as { accountId: string }).accountId).not.toBe('magicrew-other')
    expect(pool.listAccountsByProvider('magicrew')).toHaveLength(2)
  })

  it('⚠️ 既有账号的凭据**读不到** ⇒ 不误判，照常新建（「无法判定 ≠ 失配」）', async () => {
    const root = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'org-cn')))
    const { call, pool } = await setupRpc(root)

    // ⚠️ 故意**不** seed 凭据：`resolve` 返回 undefined。把它判成「重复」会覆盖掉
    //    别人的凭据（不可逆）；本仓库口径是跳过、继续往下判。
    await pool.addAccount({
      id: 'magicrew-broken', provider: 'magicrew', nickname: '读不到凭据的',
      enabled: true, credentialRef: 'MAGICREW_ACCOUNT_BROKEN', refreshable: true, createdAt: 0,
    })

    const created = await call({ provider: 'magicrew', mode: 'local-browser' })
    expect(created.ok).toBe(true)
    expect(pool.listAccountsByProvider('magicrew')).toHaveLength(2)
  })
})

// ════════════════════════════════════════════════════════════════════════
// 2026-11-05 返工：sequence 去重 + tombstone（P2-2 / P2-3 的正确修法）
// ════════════════════════════════════════════════════════════════════════

/** 造一条 leveldb WAL record（`crc32 | length | type | WriteBatch`；crc 恒 0）。 */
function walRecord(
  sequence: number,
  entries: readonly { key: string, value?: string }[],
): Buffer {
  const parts: Buffer[] = []
  const seq = Buffer.alloc(8)
  seq.writeBigUInt64LE(BigInt(sequence))
  const count = Buffer.alloc(4)
  count.writeUInt32LE(entries.length)
  parts.push(seq, count)
  for (const entry of entries) {
    const key = Buffer.from(entry.key, 'latin1')
    if (entry.value === undefined) {
      parts.push(Buffer.from([0]), Buffer.from(varintBytes(key.length)), key)
      continue
    }
    const value = Buffer.from(entry.value, 'latin1')
    parts.push(
      Buffer.from([1]),
      Buffer.from(varintBytes(key.length)), key,
      Buffer.from(varintBytes(value.length)), value,
    )
  }
  const payload = Buffer.concat(parts)
  const header = Buffer.alloc(7)
  header.writeUInt16LE(payload.length, 4)
  header[6] = 1
  return Buffer.concat([header, payload])
}

/** 最小的 varint 编码（fixture 专用；只处理非负小整数）。 */
function varintBytes(value: number): number[] {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest)
  return bytes
}

/** Chromium 给 localStorage value 加的编码头 `0x01`（Latin-1）+ JSON。 */
function walValue(name: string, value: string): string {
  return String.fromCharCode(1) + JSON.stringify({ key: name, value })
}

/** 真实 localStorage 的 WAL key：`_<origin>\x00\x01<带前缀的 name>`。 */
function walKey(name: string): string {
  return `_${ORIGIN_CN}\u0000\u0001MAGIC:user:${name}`
}

/** 把若干 WAL record 写进临时 User Data 根目录的指定文件。 */
function writeWalFiles(files: Record<string, Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'magicrew-wal-'))
  const dir = join(root, 'Default', 'Local Storage', 'leveldb')
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return root
}

describe('★★ sequence 去重与 tombstone（P2-2 / P2-3 的正确修法）', () => {
  it('★ 同一 .log 内：新值覆盖旧值（取 sequence 最大）', () => {
    const root = writeWalFiles({
      '000005.log': Buffer.concat([
        walRecord(100, [{ key: walKey('authorization'), value: walValue('authorization', JWT_EXPIRED) }]),
        walRecord(200, [{ key: walKey('authorization'), value: walValue('authorization', JWT_LIVE) }]),
        walRecord(200, [{ key: walKey('organizationCode'), value: walValue('organizationCode', 'ORG-LIVE') }]),
      ]),
    })
    expect(readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW })).toEqual({
      jwt: JWT_LIVE, organizationCode: 'ORG-LIVE', expiresAt: (Math.floor(NOW / 1000) + 3600) * 1000,
    })
  })

  it('★★ tombstone 较新（登出）⇒ 该 key 消失，不得复活旧 org', () => {
    const root = writeWalFiles({
      '000005.log': walRecord(100, [
        { key: walKey('authorization'), value: walValue('authorization', JWT_LIVE) },
        { key: walKey('organizationCode'), value: walValue('organizationCode', 'ORG-OLD') },
      ]),
      '000006.log': walRecord(200, [{ key: walKey('organizationCode') }]),
    })
    expect(credsNear(leveldbTextFor(root), 'www.letsmagic.cn')).toEqual([])
    expect(readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW })).toBeUndefined()
  })

  it('★★ 空值较旧、新值较新（先登出再登录）⇒ 必须读到新 org，不得漏读', () => {
    const root = writeWalFiles({
      '000005.log': walRecord(100, [
        { key: walKey('authorization'), value: walValue('authorization', JWT_LIVE) },
        { key: walKey('organizationCode') },
      ]),
      '000006.log': walRecord(200, [
        { key: walKey('organizationCode'), value: walValue('organizationCode', 'ORG-LIVE') },
      ]),
    })
    expect(credsNear(leveldbTextFor(root), 'www.letsmagic.cn')).toEqual([
      { jwt: JWT_LIVE, organizationCode: 'ORG-LIVE' },
    ])
  })
})

// ════════════════════════════════════════════════════════════════════════
// 2026-11-05 审计返工：四条守卫（每条都对应一个「全绿但真机失效」的缝）
// ════════════════════════════════════════════════════════════════════════

describe('★★ leveldb 读取的四个返工点（审计 2026-11-05）', () => {
  /**
   * ① 文件之间**必须**用 `\n` 隔开。
   *
   * 判据打在行为上：把一条 JSON 从中间劈开、分放两个文件 ——
   * - 有分隔符 ⇒ `"key":"authoriz\nation"` 不匹配 ⇒ **读不到**（正确）；
   * - 无分隔符 ⇒ 拼成 `"key":"authorization"` ⇒ 凭空读出一对凭据（错误）。
   *
   * ⚠️ 这里**不能**只断言 `text.includes('\n')`：那是源码文本断言，
   * 把 join 换成 `join('\n\n')` 之类的等价写法会假红，而真正的
   * 「跨文件拼接」缺陷反而可能漏掉。
   */
  it('★ 文件边界的半个 key 不得被拼成完整凭据（join 分隔符）', () => {
    const root = mkdtempSync(join(tmpdir(), 'magicrew-split-'))
    const dir = join(root, 'Default', 'Local Storage', 'leveldb')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '000001.log'),
      Buffer.from(`_${ORIGIN_CN}\u0000\u0001x{"key":"authoriz`, 'latin1'),
    )
    writeFileSync(
      join(dir, '000002.log'),
      Buffer.from(`ation","value":"${JWT_LIVE}"}{"key":"organizationCode","value":"ORG-SPLIT"}`, 'latin1'),
    )
    const text = leveldbTextFor(root)
    expect(credsNear(text, 'www.letsmagic.cn')).toEqual([])
    // 反向对照：同一个文件里完整写一遍 ⇒ 必须读得到（否则本用例恒真）。
    const root2 = makeUserData(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'ORG-ONE-FILE')))
    expect(credsNear(leveldbTextFor(root2), 'www.letsmagic.cn')).toEqual([
      { jwt: JWT_LIVE, organizationCode: 'ORG-ONE-FILE' },
    ])
  })

  /**
   * ② 空 `organizationCode`：**保守放弃**这把 jwt（2026-11-05 审计复核后的结论）。
   *
   * 初版审计报「空值遮蔽有效 org ⇒ 凭据整条丢失（P2-6）」，但复核发现
   * LevelDB 的 internal key 是「user key 升序、同 key 内 **sequence 降序**」
   * ⇒ 同一 key 的**最新写入排在最前**，所以「空值在前」= 空值**较新**
   * （登出/切组织的 tombstone），后面那个有效值是**已删除的陈旧值**。
   * 去够它 = 复活一个已登出的组织（`jwt_stale × org_new` 在上游是
   * HTTP 200 + `code:403`，还会把已删的账号加回池里）。
   *
   * ⇒ 判据是「**放弃**」，不是「继续找」；跨 `.log`/跨文件的旧在前形态
   * 无法只靠文本区分（需要 8 字节 trailer 的 sequence，见文档「已知边界」）。
   */
  it('★ 空 org（tombstone）在前 ⇒ 放弃这把 jwt；有效值在前 ⇒ 正常配对', () => {
    const tombstoneFirst = storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, ''))
      + storageEntry(ORIGIN_CN, 'y', `{"key":"organizationCode","value":"STALE-ORG"}`)
    expect(credsNear(tombstoneFirst, 'www.letsmagic.cn')).toEqual([])

    // 反向对照：写的是「有效 org 在前、空值在后」（有效值较新）⇒ 必须配对成功。
    const liveFirst = storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'ORG-LIVE'))
      + storageEntry(ORIGIN_CN, 'y', `{"key":"organizationCode","value":""}`)
    expect(credsNear(liveFirst, 'www.letsmagic.cn')).toEqual([
      { jwt: JWT_LIVE, organizationCode: 'ORG-LIVE' },
    ])
  })

  /**
   * ③ `.sst` 与 `.ldb` 同格式，必须一起解 —— 否则它会退回「原文扫描」那条
   * 坏路（= 修复前的行为），而 `.sst` 里的压缩块同样读不出东西。
   *
   * 判据：把一个**不是合法 SSTable** 的 `.sst` 写进去（内容恰好是明文凭据）。
   * - 走解码 ⇒ 解析失败 ⇒ 跳过 ⇒ 读不到（正确）；
   * - 退回 latin1 ⇒ 明文命中 ⇒ 读得到（错误）。
   */
  it('★ .sst 必须走 SSTable 解码，不得回落成原文扫描', () => {
    const root = mkdtempSync(join(tmpdir(), 'magicrew-sst-'))
    const dir = join(root, 'Default', 'Local Storage', 'leveldb')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '000004.sst'),
      Buffer.from(storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'ORG-SST')), 'latin1'),
    )
    expect(readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW })).toBeUndefined()
  })

  /**
   * ④b 两个 provider（`magicrew` / `magicrewintl`）扫**同一批**浏览器路径 ⇒
   * 去重键不能是「全局路径」，否则先跑的那个把路径吃掉、另一个的 logger 永远收不到。
   * 判据：两个不同 `log` 出口各得一条；同一个出口仍只有一条。
   */
  it('★ 不同 log 出口各自去重（两个 provider 都要看得见）', () => {
    const root = mkdtempSync(join(tmpdir(), 'magicrew-warn-perlog-'))
    const dir = join(root, 'Default', 'Local Storage', 'leveldb')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '000007.ldb'), Buffer.from('broken-bytes', 'latin1'))
    const first: string[] = []
    const second: string[] = []
    // ⚠️ 出口必须是**稳定引用**（每次 new 一个箭头函数会让去重按身份分桶失效）。
    const sinkA = (message: string): void => { first.push(message) }
    const sinkB = (message: string): void => { second.push(message) }
    readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW, log: sinkA })
    readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW, log: sinkB })
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    // 同一个出口再跑一次仍只有一条（轮询去重）。
    readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW, log: sinkA })
    expect(first).toHaveLength(1)
  })

  /**
   * ⑤ warn 必须**透传**到宿主注入的 `warn`（2026-11-05 返工自查）。
   *
   * `leveldbTextForFile` 的默认出口是 `console.warn`；若 `MagicrewAuth` 不把
   * `options.warn` 转成 `log`，宿主日志系统收不到 ⇒ 生产里「有日志」但人看不见，
   * 单测也断言不到 —— 那就是**假修**。
   */
  it('★★ 解析失败的 warn 必须透传到宿主 logger（不是只打到 console）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'magicrew-auth-warn-'))
    const dir = join(root, 'Default', 'Local Storage', 'leveldb')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '000006.ldb'), Buffer.from('not-a-sstable', 'latin1'))
    const store = new FakeStore()
    const warnings: string[] = []
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const auth = new MagicrewAuth(makeContext(store), {
        store,
        browserRoots: [root],
        warn: (message: string) => warnings.push(message),
        fetchImpl: (async () => {
          throw new Error('坏文件不得触发网络请求')
        }) as unknown as typeof fetch,
      })
      expect(await auth.importFromLocalBrowser()).toBeUndefined()
      expect(warnings.filter((line) => line.includes('000006.ldb'))).toHaveLength(1)
      // ⚠️ 反向对照：注入 warn 时**不得**再打 console（单出口不变式，
      //    2026-11-05 合规/对抗审计 P2-1 的假绿面）。
      expect(consoleSpy).not.toHaveBeenCalled()
    } finally {
      consoleSpy.mockRestore()
    }
  })

  /**
   * ★★ ⑤b **生产形态**：`index.ts` 两处 `new MagicrewAuth(ctx)` 都**不注入**
   * `warn`。若 `log` 只取 `warnImpl`（单测专用），生产里就恒 `undefined` ⇒
   * 只剩 `console.warn`、宿主结构化日志收不到（2026-11-05 对抗审计 P1-1）。
   * 判据：不传 `warn`，`ctx.logger.warn` 必须收到。
   */
  it('★★ 生产形态（不注入 warn）也必须打到 ctx.logger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'magicrew-auth-ctxlog-'))
    const dir = join(root, 'Default', 'Local Storage', 'leveldb')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '000008.ldb'), Buffer.from('broken', 'latin1'))
    const store = new FakeStore()
    const logged: string[] = []
    const ctx = makeContext(store)
    // ⚠️ `ctx.logger` 在 cordis 里是**可变属性**，直接替换（`provide('logger')` 不生效）。
    ;(ctx as unknown as { logger: { warn: (message: string) => void } }).logger = {
      warn: (message: string) => logged.push(message),
    }
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const auth = new MagicrewAuth(ctx, {
        store,
        browserRoots: [root],
        fetchImpl: (async () => {
          throw new Error('坏文件不得触发网络请求')
        }) as unknown as typeof fetch,
      })
      expect(await auth.importFromLocalBrowser()).toBeUndefined()
      expect(logged.some((line) => line.includes('000008.ldb'))).toBe(true)
      expect(consoleSpy).not.toHaveBeenCalled()
    } finally {
      consoleSpy.mockRestore()
    }
  })

  /**
   * ⑥ 大小写不敏感后缀（2026-11-05 对抗审计 P3-3）：`.LDB` / `.SST` 必须与
   * 小写同路径（解码失败即跳过），**不得**退回「原文扫描」从原始字节编造凭据。
   */
  it('★ .LDB / .SST 大写后缀也必须走解码（不得回落原文扫描）', () => {
    for (const name of ['000009.LDB', '000010.SST']) {
      const root = mkdtempSync(join(tmpdir(), 'magicrew-upper-'))
      const dir = join(root, 'Default', 'Local Storage', 'leveldb')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), Buffer.from(
        storageEntry(ORIGIN_CN, 'x', credentialPair(JWT_LIVE, 'ORG-UPPER')), 'latin1',
      ))
      expect(
        readMagicrewLocalCreds('www.letsmagic.cn', { roots: [root], now: NOW, log: () => {} }),
        name,
      ).toBeUndefined()
    }
  })

  /**
   * ④ 解析失败必须**留一条日志**（每个文件一次），否则「解析器坏了」与
   * 「用户没登录」完全同形（审计 P1-3）。
   */
  it('★ 坏 .ldb 解析失败要 warn（含文件名），且同一文件不刷屏', () => {
    const root = mkdtempSync(join(tmpdir(), 'magicrew-warn-'))
    const dir = join(root, 'Default', 'Local Storage', 'leveldb')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '000005.ldb'), Buffer.from('not-a-sstable-at-all', 'latin1'))
    const lines: string[] = []
    const options = { roots: [root], now: NOW, log: (message: string) => lines.push(message) }
    expect(readMagicrewLocalCreds('www.letsmagic.cn', options)).toBeUndefined()
    expect(readMagicrewLocalCreds('www.letsmagic.cn', options)).toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('000005.ldb')
    // 日志**不得**带文件内容（可能含别的站点 token）。
    expect(lines[0]).not.toContain('not-a-sstable')
  })
})
