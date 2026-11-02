/**
 * ZCode 的 Jet Hub 接入回归。
 *
 * 这些用例守的是**上一轮评审指出的六处接线缺口** —— 它们全都属于
 * 「不报错、只是功能静默不可用」那一类，故必须有回归防线：
 *
 * | 缺口 | 症状 | 本文件的对应用例 |
 * |---|---|---|
 * | `ZcodeAuth` 未继承 `Service` | `ctx.zcodeAuth` 恒为 undefined | 「注册 ctx.zcodeAuth」 |
 * | RPC 无 zcode 分支 | `account.create` 报 `unknown provider` | 「account.create 支持 zcode」 |
 * | 客户端 `PROVIDERS` 无 zcode | Jet Hub 里根本看不到面板 | 「客户端面板已登记」 |
 * | 能力矩阵未登记 | 不渲染余额 / 签到按钮 | 「能力矩阵已登记」 |
 * | 前端对空 loginUrl 报错 | 「添加账号」必然失败 | 「前端不再把空 loginUrl 当错误」 |
 * | 无单测 | 回归无防线 | 本文件 |
 *
 * ## ⚠ 2026-10-05 更新：凭据只有**一个**来源
 *
 * 「ZCode 插件读取本机官方客户端数据」的能力已整体删除，于是
 * `ZcodeAuthOptions.readCredential` 这个测试注入点与 `adoptOfficialCredential` /
 * `adoptIntoOrphanAccount` / `localCredential` 那套自愈链路**都不存在了**
 * （本文件里引用它们的用例：注入点改为走真实的 `ctx.credentials`，
 * 自愈链路那 7 条删除并在原位留注释）。
 * ⇒ 凭据一律经 `ctx.credentials`（账号池 → `ZCODE.defaultCredentialRef`）供给；
 * 「插件自存缺失时**不再**有任何本机回退」改写成一条反向用例。
 * 防回退锁在 `tests/unit/zcode-no-local-credential-read.spec.ts`。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZCODE } from '../../src/zcode-product.js'
import { AccountPool } from '../../src/account-pool.js'
import { CREDITS_CAPABILITIES } from '../../plugin-src/client/credits-capabilities.js'
import { PROVIDER_ICONS } from '../../plugin-src/client/provider-icons.js'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { jetHubAuthsCallKeys, jetHubAuthsInterfaceKeys } from '../helpers/jet-hub-auths.js'
import { accountEntry, refreshHarness } from '../helpers/rpc-refresh.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const readClient = (name: string): string =>
  readFileSync(resolve(HERE, '../../plugin-src/client', name), 'utf8')

/** 一个只满足 `ZcodeAuth` 构造需求的最小 ctx。 */
function makeCtx(): Context {
  const ctx = new Context()
  const store = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'test' }
    },
    describe: async (ref: string) => ({ configured: store.has(ref), writable: true }),
    set: async (ref: string, value: string) => { store.set(ref, value) },
    unset: async (ref: string) => { store.delete(ref) },
  } as never)
  return ctx
}

describe('ZCode 服务注册（缺口 1：必须 extends Service）', () => {
  it('★ 构造后 ctx.zcodeAuth 立即可用（由 Service 基类完成 provide）', () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    /**
     * ⚠ 不能断言**引用相等** —— cordis 的 `Service` 用代理包装实例
     * （为了 `ctx.reflect` 的拦截配置），故 `ctx.zcodeAuth !== instance`。
     * 这与 `raccoonAuth` / `loomyAuth` 的行为**完全一致**（实测）。
     *
     * 真正要守的性质是「**已注册**」：初版是裸 class，那时
     * `ctx.zcodeAuth` 恒为 `undefined`。
     */
    const registered = (ctx as unknown as Record<string, unknown>).zcodeAuth as
      | { name?: string; constructor?: { name?: string } }
      | undefined
    expect(registered).toBeDefined()
    expect(registered?.name).toBe('zcodeAuth')
    expect(registered?.constructor?.name).toBe('ZcodeAuth')
    // 实例本身仍是构造出来的那个（供 index.ts 持有引用）。
    expect(auth.name).toBe('zcodeAuth')
  })

  it('★ 注册行为与既有 auth 服务**逐项一致**（zcode 不是特例）', async () => {
    const { RaccoonAuth } = await import('../../src/raccoon-auth.js')
    const { ZcodeAuth: Z } = await import('../../src/zcode-auth.js')
    const ctx = makeCtx()
    const raccoon = new RaccoonAuth(ctx)
    const zcode = new Z(ctx)
    const ra = (ctx as unknown as Record<string, unknown>).raccoonAuth as { name?: string }
    const zc = (ctx as unknown as Record<string, unknown>).zcodeAuth as { name?: string }
    expect(zc).toBeDefined()
    expect(ra).toBeDefined()
    // 两者都「有 name」且都被代理解包（不是各自的 raw 实例）。
    expect(zc?.name).toBe('zcodeAuth')
    expect(ra?.name).toBe('raccoonAuth')
    expect(zc).not.toBe(zcode)
    expect(ra).not.toBe(raccoon)
  })

  it('服务名是 zcodeAuth，且与其余 auth 服务不冲突', () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    expect(auth.name).toBe('zcodeAuth')
  })

  it('服务名可由 options 覆盖（与 RaccoonAuth 同款能力）', () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx, { serviceName: 'customZcode' })
    expect(auth.name).toBe('customZcode')
  })

  it('凭据 ref 名与产品配置一致', () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    expect(auth.credentialRefName).toBe(ZCODE.defaultCredentialRef)
  })

  it('契约要求的方法都在（index.ts 会无条件调用 stop）', () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    for (const method of ['login', 'startLogin', 'stop', 'status', 'refreshAll', 'refreshAccountCredential', 'fetchModels']) {
      expect(typeof (auth as unknown as Record<string, unknown>)[method], method).toBe('function')
    }
    expect(() => auth.stop()).not.toThrow()
  })
})

describe('ZCode 无实例依赖（核心架构声明）', () => {
  /**
   * ⚠️ 这一组用例在「插件内登录」落地后**被重写过**，又在 2026-10-05
   *    「不读本机 ZCode 数据」后**再改写一次**。
   *
   * 早期实现是「读官方客户端的凭据文件」，那时 zcode **没有 loginUrl**
   * （没有浏览器授权步骤）。随后改为走官方 CLI 设备授权流
   * （`/oauth/cli/init` → 浏览器授权 → `/oauth/cli/poll`），
   * 所以 `startLogin` 会返回**真实的授权 URL**。
   *
   * 断言随之改为「URL 是 https 且指向授权域」——
   * 这比原来的 `toBeUndefined()` 更有价值。
   *
   * ⚠ 最后一次改写：早期「两个来源（插件自存 > 官方客户端凭据文件）」与
   * 「插件自存缺失时回退到官方客户端凭据文件」两条已**删除/反转** ——
   * 凭据现在**只有插件自存这一个来源**，回退那条路不存在了。
   */
  it('★ startLogin 返回真实的官方授权 URL（两步式，立刻可弹窗）', async () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx, {
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).endsWith('/oauth/cli/init')) {
          return new Response(JSON.stringify({
            code: 0,
            data: {
              flow_id: 'flow-1',
              authorize_url: 'https://bigmodel.cn/login?appId=zcode&state=abc',
              expires_at: Math.floor(Date.now() / 1000) + 300,
              poll_interval_sec: 2,
            },
          }), { status: 200 })
        }
        // 轮询一直 pending，让 result 不 settle（本用例只验 URL）。
        return new Response(JSON.stringify({ code: 0, data: { status: 'pending' } }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const started = await auth.startLogin()
    expect(typeof started.loginUrl).toBe('string')
    expect(started.loginUrl).toMatch(/^https:\/\//)
    expect(started.loginUrl).toContain('bigmodel.cn')
    // ⚠️ 立刻返回（不等授权完成）—— 否则 window.open 会被弹窗拦截。
    expect(started.result).toBeInstanceOf(Promise)
    // 避免未处理的 rejection（本用例不 await 它）。
    void started.result.catch(() => {})
  })

  it('★ login 把**插件自建**凭据写进 ctx.credentials（含自生成 device_mid）', async () => {
    const ctx = makeCtx()
    let pollCount = 0
    const auth = new ZcodeAuth(ctx, {
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).endsWith('/oauth/cli/init')) {
          return new Response(JSON.stringify({
            code: 0,
            data: {
              flow_id: 'flow-2',
              authorize_url: 'https://bigmodel.cn/login?appId=zcode&state=xyz',
              expires_at: Math.floor(Date.now() / 1000) + 300,
              poll_interval_sec: 1,
            },
          }), { status: 200 })
        }
        pollCount += 1
        if (pollCount < 2) {
          return new Response(JSON.stringify({ code: 0, data: { status: 'pending' } }), { status: 200 })
        }
        return new Response(JSON.stringify({
          code: 0,
          data: {
            status: 'ready',
            token: 'plugin-jwt',
            user: { user_id: 'u-1', name: '插件登录用户' },
            bigmodel: { access_token: 'bm-token' },
          },
        }), { status: 200 })
      }) as unknown as typeof fetch,
    })

    const saved = await auth.login({ refName: 'MY_REF' })
    expect(saved.refName).toBe('MY_REF')
    expect(saved.credential.zcode_jwt).toBe('plugin-jwt')
    expect(saved.credential.account_label).toBe('插件登录用户')
    expect(saved.credential.source).toBe('plugin')
    /**
     * ★ 关键：`device_mid` 是**插件自己生成**的 UUID，
     * 不再读官方客户端的 `telemetry-state.json` —— 这是「脱离 IDE」的核心。
     */
    expect(saved.credential.device_mid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    // 且已持久化（JSON 字符串，不是对象）。
    const stored = await ctx.credentials.resolve('MY_REF' as never)
    expect(stored?.value).toBe(JSON.stringify(saved.credential))
  })

  it('★ 插件自存的凭据就是**唯一**来源（账号池 → 单凭据 ref）', async () => {
    const ctx = makeCtx()
    await ctx.credentials.set(ZCODE.defaultCredentialRef as never, JSON.stringify({
      zcode_jwt: 'from-plugin',
      device_mid: 'plugin-mid',
      source: 'plugin',
    }))
    // ⚠ 刻意**不**再注入 `readCredential`：那个选项就是「回退去读本机官方 ZCode
    //   客户端凭据文件」的测试注入点，已随 2026-10-05 的决策整体删除。
    const auth = new ZcodeAuth(ctx)
    const current = await auth.current()
    expect(current?.zcode_jwt).toBe('from-plugin')
    expect(current?.device_mid).toBe('plugin-mid')
  })

  /**
   * ★ **反向用例**（2026-10-05「不读本机 ZCode 数据」决策的直接后果）。
   *
   * 旧行为：插件自存缺失时**回退去读本机官方客户端的凭据文件**
   *（`~/.zcode/v2/credentials.json`），于是「装了官方客户端并登录过」的机器
   * 零操作可用 —— 现在这个入口**不存在**了。
   *
   * 守的性质：插件自存缺失 ⇒ `current()` 就是 `undefined`，
   * **没有**任何本机回退。防止有人日后「顺手」把回退加回来。
   * 静态层的防回退锁在 `tests/unit/zcode-no-local-credential-read.spec.ts`。
   */
  it('★ 插件自存缺失时 current() 返回 undefined（**不再**回退到任何本机数据）', async () => {
    const ctx = makeCtx()
    // ctx.credentials 里**什么都没有**（没装本插件的任何登录态）。
    const auth = new ZcodeAuth(ctx)
    expect(await auth.current()).toBeUndefined()
  })

  it('★ 持久化里的残留垃圾不会被当凭据用（形状校验）', async () => {
    const ctx = makeCtx()
    await ctx.credentials.set(ZCODE.defaultCredentialRef as never, 'not-json-at-all')
    const auth = new ZcodeAuth(ctx)
    // 坏 JSON → 视为「没有自存凭据」⇒ **不再**有任何回退来源 ⇒ undefined。
    expect(await auth.current()).toBeUndefined()
  })

  it('model 目录是静态白名单（不发网络请求）—— 且含 GLM-5.3-Flash', async () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    const models = await auth.fetchModels()
    expect(models.map((m) => m.id)).toContain('GLM-5.3-Flash')
    // 只暴露实测可用的两个（GLM-5-Turbo / GLM-5.2 实测返回空响应）。
    expect(models).toHaveLength(2)
  })

  it('probe 在无凭据时返回 available:false，且原因**指向插件内登录**', async () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    const result = await auth.probe()
    expect(result.available).toBe(false)
    /**
     * ⚠️ 文案必须同时提到「插件内登录」与「**不读本机**」——
     * 旧文案说的是「若已装官方 ZCode 客户端并登录过，本插件也会自动读取它的
     * 凭据」，那句已随 2026-10-05 的决策从源码里删掉了。现在要引导用户的只有
     * Jet Hub 里的登录，且必须**明确否定**「装了客户端就能用」这个已被删除的
     * 预期（否则用户会去找根本不存在的路径）。
     */
    expect(result.reason).toMatch(/添加账号/)
    expect(result.reason).toMatch(/不会读取本机 ZCode 客户端的登录态/)
  })

  it('refreshAccountCredential 无凭据时如实抛错（不静默成功）', async () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    /**
     * ⚠ 文案已随修复调整（2026-10-02）：现在报的是**该账号自己的凭据**不可用，
     * 而不是「请去官方客户端重新登录」——因为后者会诱导用户去做一件
     * **无法解决该问题**的事（多账号场景下磁盘凭据只对应一个账号）。
     */
    await expect(auth.refreshAccountCredential('R')).rejects.toThrow(/不可用或已损坏/)
  })

  /**
   * ★ 本条在 2026-10-02 被**改写**，因为它此前断言的是**缺陷行为**。
   *
   * ## 旧断言（错的）
   *
   * ```ts
   * await auth.refreshAll(pool)   // pool 有两个空 ref 的账号
   * expect(REF_1).toBe(磁盘凭据)   // ← 断言「都被写入同一份」
   * expect(REF_2).toBe(磁盘凭据)   // ← 同上
   * ```
   *
   * 测试名写着「逐账号隔离失败」，说明**作者当时就意识到这不隔离**，
   * 却把它固化成预期。而它正是用户 2026-10-02 报障的根因：
   * 单账号的磁盘凭据被铺进**每一个**账号条目，抹掉了其余账号的真实凭据。
   *
   * ## 新语义（正确）
   *
   * ZCode **不可续期**，故 `refreshAll` 做的是**逐账号对账**：
   * 每个账号读**自己的** ref，能解出就写回自己，解不出就**跳过**。
   * 它**绝不**使用「别处的那份凭据」去填任意账号 —— 凭据存储里可能同时躺着
   * 别的账号（甚至单凭据 ref）那份，它无法判断属于池里哪一个。
   */
  it('★ refreshAll 逐账号各写各的：不把别的凭据铺进（也不会覆盖）任何账号', async () => {
    const ctx = makeCtx()
    // ⚠ 存储里**确实**躺着另一份凭据（单凭据 ref），它不该被填进这两个空 ref。
    //   早期这条用 `readCredential` 注入同一个形状的「本机凭据」；那个注入点已随
    //   2026-10-05 的「不读本机 ZCode 数据」决策删除 ⇒ 改用**真实的凭据存储**
    //   摆出同样的前提（判据不变：两个空 ref 必须保持空）。
    await ctx.credentials.set(ZCODE.defaultCredentialRef as never, JSON.stringify({
      zcode_jwt: 'a.b.c', device_mid: 'm',
    }))
    const auth = new ZcodeAuth(ctx)
    const pool = {
      listAccountsByProvider: () => [
        { id: 'z1', credentialRef: 'REF_1' },
        { id: 'z2', credentialRef: 'REF_2' },
      ],
    } as unknown as AccountPool

    await auth.refreshAll(pool)

    /**
     * ★ 两个 ref 都是空的 ⇒ 都必须**保持空**（跳过），
     * 绝不能被存储里那份凭据填上（那是旧行为，也是数据破坏的来源）。
     */
    expect(await ctx.credentials.resolve('REF_1' as never)).toBeUndefined()
    expect(await ctx.credentials.resolve('REF_2' as never)).toBeUndefined()
  })

  it('★ refreshAll 对「有自己凭据」的账号原样写回自己（不串号）', async () => {
    const ctx = makeCtx()
    const credA = { zcode_jwt: 'jwt-A', device_mid: 'mid-A', account_label: 'A' }
    const credB = { zcode_jwt: 'jwt-B', device_mid: 'mid-B', account_label: 'B' }
    await ctx.credentials.set('REF_A' as never, JSON.stringify(credA))
    await ctx.credentials.set('REF_B' as never, JSON.stringify(credB))
    // ⚠ 刻意让「别处那份」是 A —— 旧实现会把它铺进 B。
    await ctx.credentials.set(ZCODE.defaultCredentialRef as never, JSON.stringify(credA))

    const auth = new ZcodeAuth(ctx)
    const pool = {
      listAccountsByProvider: () => [
        { id: 'a', credentialRef: 'REF_A' },
        { id: 'b', credentialRef: 'REF_B' },
      ],
    } as unknown as AccountPool

    await auth.refreshAll(pool)

    // ★ B 必须仍是 B 自己（旧实现这里会变成 A）。
    const gotB = JSON.parse((await ctx.credentials.resolve('REF_B' as never))?.value ?? '{}')
    expect(gotB.zcode_jwt).toBe('jwt-B')
    expect(gotB.account_label).toBe('B')
    const gotA = JSON.parse((await ctx.credentials.resolve('REF_A' as never))?.value ?? '{}')
    expect(gotA.zcode_jwt).toBe('jwt-A')
  })
})

/*
 * ⚠⚠ **原「ZCode 自愈链路的两道闸（★ 防跨账号覆盖）」整组 7 条用例已删除。**
 *
 * 那组用例守的是 `ZcodeAuth.adoptOfficialCredential()` —— 本插件里**唯一**会把
 * 「本机读到的官方客户端凭据」写进某个账号 ref 的入口，也是唯一可能重演
 * 「凭据铺满整池」那类跨账号数据破坏的地方。**该方法连同 `adoptIntoOrphanAccount()`
 * / `localCredential()` / `hasStoredCredential()` / `hasOtherZcodeAccounts()`
 * 已随「不读本机 ZCode 数据」的用户决策（2026-10-05）整体删除** ——
 * 凭据既然不再从本机读，「把本机凭据收编进账号池」这条自愈链路就没有存在
 * 的前提了，调用它会直接 `TypeError`。
 *
 * ⇒ 「不读本机 ZCode 数据」的防回退锁在
 *    **`tests/unit/zcode-no-local-credential-read.spec.ts`**（扫源码字面量：
 *    `readCredential` 注入点、`adopt*` / `localCredential` 系列、本机路径与
 *    派生密钥字面量，一处都不许重新出现）。
 * ⇒ 「`current()` 在插件自存缺失时不再有任何本机回退」这条**行为**断言，
 *    已改写成反向用例留在上一组（见「★ 插件自存缺失时 current() 返回
 *    undefined」），**不是**随这 7 条一起删掉。
 */

describe('ZCode 客户端接入（缺口 3 / 4 / 5）', () => {
  it('★ PROVIDERS 里已登记 zcode（否则 Jet Hub 根本没这个面板）', () => {
    // ⚠️ 2026-10-08 改：原先从**客户端源码文本**正则
    // `/const PROVIDERS = Object\.freeze\(\[([\s\S]*?)\n\]\);/` +
    // `/id: '([^']+)'/g` 派生 id。客户端 `PROVIDERS` 现由
    // `src/provider-registry.ts` 派生，故这里直接读 registry —— 不再解析源码文本。
    const ids = PROVIDER_REGISTRY.map((d) => d.id)
    expect(ids).toContain('zcode')
    // 也确认没把既有的挤掉。
    expect(ids).toContain('codearts')
    expect(ids).toContain('raccoon')
    // ⚠️ 计数会随 provider 增删变化（2026-09-30 加 minimax：11 → 12；
    // 2026-10-01 加 opencode：12 → 13；2026-10-03 加 gemini：13 → 14；
    // 2026-10-07 加 aggregate：14 → 15；2026-10-12 加 officeace：15 → 16；
    // 2026-10-13 加 accio：16 → 17；2026-10-15 加 minimaxintl：17 → 18；
    // 2026-10-16 加 astudio：18 → 19；
    // 2026-10-17 加 autoclaw：19 → 20；
    // 2026-10-16 **本 fork** 加 modelscope（魔搭）：20 → 21；
    // 2026-10-19 **本 fork** 加 codely（Unity 团结引擎，UI 先行）：20 → 21；
    // 2026-10-20 加 autoclawintl（AutoClaw 国际版）：21 → 22）。
    // ⚠️ 这个断言的价值是「**别把既有 provider 挤掉**」，所以它同时断言
    // 上面的具体 id；若将来再加 provider，记得同步这里。
    // 2026-10-29 fork: qiniu + magicrew added -> 24 -> 25.
    // 2026-11-01 fork: magicrewintl（MagiCrew 国际版）added -> 25 -> 26.
    // 2026-11-02 fork: monkeycode -> 27；monkeycodeintl + baizhi -> 29.
    expect(ids).toHaveLength(29)
  })

  it('展示名与产品配置一致（避免两处漂移）', () => {
    // ⚠️ 2026-10-08 改：原先正则扫 `jet-hub.js` 的 `id: 'zcode', label: '...'`。
    // 现在 label 由 registry 派生，故直接读 registry（**行为断言**）。
    expect(descriptorOf('zcode')?.label).toBe(ZCODE.displayName)
  })

  it('zcode 有内联图标且已注册 CSS 类', () => {
    // ⚠️ 2026-10-08 改：图标常量已从 `jet-hub.js` 抽到纯数据模块
    // `provider-icons.js`（因为 `jet-hub.js` import 不了 react，见
    // `provider-icons.js` 文件头）。断言改为读该模块的实际值。
    expect(PROVIDER_ICONS.zcode).toMatch(/^data:image\/png;base64,/)
    expect(readClient('jet-hub-styles.js')).toMatch(/\.dim-jh-providerIcon\.zcode/)
  })

  it('★ 能力矩阵登记为「余额 + 每日签到」都有', () => {
    expect(CREDITS_CAPABILITIES.zcode).toEqual({ balance: true, dailyCheckin: true })
  })

  /**
   * ⚠️ 这条断言在「插件内登录」落地后**被替换**。
   *
   * 早期实现里 zcode 是唯一没有 `loginUrl` 的 provider，前端为它加了
   * 一个「空 loginUrl 不算错误」的特例分支。现在 zcode 走**标准两步式**
   * （返回官方授权 URL），那个特例已被删除 —— 故旧断言不再适用。
   *
   * 新断言守的是**更有价值**的性质：前端**没有**为 zcode 留下任何
   * 特殊分支（有特例就意味着某条通用路径对它不成立）。
   */
  it('★ 前端没有为 zcode 留特殊分支（它走通用两步式登录）', () => {
    const source = readClient('jet-hub.js')
    // 提交流程里不应有 zcode 专属分支。
    expect(source).not.toMatch(/else if \(provider === 'zcode'\)/)
    // 通用路径仍在：拿到 loginUrl 就弹窗。
    // ⚠️ 判据**刻意不锚定 `const`、也不锚定「声明与赋值同一行」**
    //    （2026-10-13 改造）：OfficeAce 的换账号登录需要「宿主已开无痕窗时就不再弹」
    //    的分支，于是该变量变成 `let loginWindow = null;` 提前声明、
    //    `window.open(...)` 移到分支内（两种打开方式都要持有它，供轮询结束时关窗）。
    //    本用例要守的是「**通用弹窗路径仍在**」，与声明位置无关 —— 写死形态会让
    //    一次纯结构重构假失败（仓库既有教训：接线类断言须容忍重构）。
    expect(source, '通用 window.open 弹窗路径不见了').toMatch(/window\.open\(loginUrl/)
    // 空 loginUrl 的通用错误分支也要保留（它是所有 provider 的兜底）。
    expect(source).toMatch(/后端未返回登录地址/)
  })

  it('★ 登录轮询对所有 provider 统一（含 zcode）', () => {
    const source = readClient('jet-hub.js')
    // 轮询调用不应按 provider 分叉。
    expect(source).toMatch(/rpcCall\('login\.poll', \{ accountId, provider \}\)/)
  })
})

describe('ZCode RPC 分派（缺口 2：接线）', () => {
  const readRpc = (): string =>
    readFileSync(resolve(HERE, '../../src/jet-hub-rpc.ts'), 'utf8')
  const readIndex = (): string =>
    readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8')

  /**
   * `JetHubAuths` 的**键集合** —— 取自 `src/index.ts` 的**调用点**
   * （`registerJetHubRpc(ctx, pool, { … })` 第三个实参），按 AST 读属性名。
   *
   * ## ⚠️⚠️ 2026-10-08 复审 Finding 2 的「两难」判定
   *
   * 原实现正则解析 `src/jet-hub-rpc.ts` 里 `JetHubAuths` **接口**的成员行。
   * 复审指出这是个两难：**接口在运行时没有表示**（类型被擦除），所以只能读源码
   * 文本。判定如下 —— **接口那条断言保留，但不再由它单独承担不变式**：
   *
   * 1. 不变式（「客户端每个 provider 要么有同名键、要么是被验证的豁免」）改由
   *    **调用点**承担：调用点是运行时真正传进去的那个对象，**键名即语义**，
   *    而且用 AST 读（`tests/helpers/jet-hub-auths.ts`）⇒ 重排 / 插键 / 换行 /
   *    注释都不可能让它假失败，**键真的漏了必然变红**。
   * 2. 接口那条断言**不能删**：它守的是另一件事 ——「13 个键都真的声明在接口上」。
   *    若把它改成「从 `PROVIDER_REGISTRY` 派生键集合」，就变成拿 registry 与
   *    自己比（客户端 id 集合**本身**已由 registry 派生）——**同义反复**。
   * 3. 两者由下面「接口键 === 调用点键」那条用例**交叉锁死**：接口声明了却
   *    没接线、或接线了却没声明，都会红。这就是「接口没有运行时表示」这个
   *    两难的出路 —— 接口不能单独成为权威，但它可以且必须与运行时权威一致。
   */
  const jetHubAuthKeys = (): string[] =>
    Object.keys(jetHubAuthsCallKeys(readIndex()))

  /** `JetHubAuths` **接口**声明的成员键（类型层权威，按声明顺序）。 */
  const jetHubAuthInterfaceKeys = (): string[] =>
    jetHubAuthsInterfaceKeys(readRpc())

  /** 客户端 `PROVIDERS` 表里的 provider id，按声明顺序。
   *  ⚠️ 2026-10-08：改为直接读 `PROVIDER_REGISTRY`（客户端 `PROVIDERS`
   *  已由它派生），不再用正则解析 `jet-hub.js` 的源码文本。 */
  const clientProviderIds = (): string[] => PROVIDER_REGISTRY.map((d) => d.id)

  it('★ `JetHubAuths` 接口声明的键 === index.ts 调用点实际传的键（两难：接口无运行时表示，故与运行时权威交叉锁死）', () => {
    const declared = jetHubAuthInterfaceKeys()
    const wired = jetHubAuthKeys()
    // 接口多声明而没接线 ⇒ `authOf(auths, id)` 运行时拿不到实例。
    // 接线而接口没声明 ⇒ `pnpm typecheck` 会先失败（TS2561），但这里也点名。
    expect(
      [...wired].sort(),
      '接口声明了却没接线（或反之）—— 逐个点名见下面的差异',
    ).toEqual([...declared].sort())
  })

  it('★ account.create 有 zcode 分支（否则报 unknown provider）', () => {
    const source = readRpc()
    expect(source).toMatch(/else if \(provider === ZCODE\.id\) \{/)
  })

  /**
   * ⚠️ 2026-10-08 改（Task 2）：原先这条断言 `expect(readRpc()).toMatch(/case ZCODE\.id:/)`
   * —— 扫的是 `account.refresh` 那 13 个同构 `case` 里的 zcode 那一个。
   * Task 2 把它们收敛成一处查表（`authOf(auths, entry.provider)`）
   * ⇒ 该文本形态**不存在了**，而它守的意图（zcode 的续期接上了、不再报
   * `Unknown provider`）**与文本无关**。
   *
   * ⇒ 改为断言**结构**（真的走查表分派）+ **行为**（zcode 的续期落到 zcode 桩上）。
   *    行为那一半用 `refreshHarness` 直接驱动端点，比文本断言强：文本只能证明
   *    源码里有那串字符，行为能证明实参真的落到了 zcode 上。
   */
  it('★ account.refresh 走查表分派，且 zcode 账号的续期落到 zcode 桩上', async () => {
    // ⚠️ 该端点**没有面板入口**（issue IKJOZA 取证），别在测试名里写「刷新按钮」。
    const source = readRpc()
    const refreshStart = source.indexOf("case 'account.refresh':")
    expect(refreshStart, '找不到 account.refresh 分支').toBeGreaterThan(-1)
    expect(source.slice(refreshStart, refreshStart + 4000))
      .toMatch(/authOf\(auths, entry\.provider\)/)

    const target = accountEntry(ZCODE.id, 'ZCODE_ACCOUNT_WIRE')
    const harness = refreshHarness([target])
    const result = await harness.call(target.id)
    expect(result.ok, `zcode 续期应成功，实际 error=${result.error?.message}`).toBe(true)
    expect(harness.calls.map((c) => c.provider)).toEqual([ZCODE.id])
  })

  /**
   * ⚠️ 2026-10-08（Task 11-B）：本组两条原先都是**源码文本断言**
   * （`expect(readRpc()).toMatch(/req\.provider === ZCODE\.id/)` 与
   * `toMatch(/claimDailyFor/)`），现已删除。理由：
   *
   * 1. 第五行那种正则**只要源码里出现该字符串就通过** —— 它证明不了
   *    「claimAll 真的为 zcode 走特例分支、真的逐 plan 现产 captcha」；
   * 2. 它依赖 `ZCODE.id` 仍以字面量出现在 `jet-hub-rpc.ts` 里，Task 3 就动过这类形态。
   *
   * ⚠️ 它们守的意图**已由一条强得多的行为用例覆盖**：
   * `tests/unit/claim-runtime-parity.spec.ts` 的
   * 「★ 豁免者 zcode 真的能签到（真跑端点，证明特例分支没断）」——
   * 它真跑 `credits.claimAll`（provider=zcode），并断言：
   * - `result.ok === true`（特例分支没断，不是 `unsupported provider`）；
   * - **逐 plan 展开** `results` 为 2 条、金额 111/222（证明走的是「自己遍历账号与
   *   plan」那条形状，而不是共享骨架那条「一账号一条 outcome」）；
   * - `perPlan.length === 2`（**captcha 真的现产了两次**，复用会得上游 3007）。
   *
   * 下面保留的这两条断言的是**能力登记**（registry 派生），与实现写法无关 ——
   * 它们仍能在「有人把 zcode 从能力表里摘掉」时点名报警。
   */
  it('★ zcode 的余额能力（registry 判据）：声明 balance', () => {
    // ⚠️ zcode 的量纲是 **token 而非积分** —— 能力矩阵回答的是「有没有这项能力」，
    //    不是「量纲是否一致」（量纲差异在面板与 RPC 层如实标注，见 registry 注释）。
    // ⚠️ 行为侧由 `credits-runtime-parity.spec.ts` 的
    //    「★★ 逐家余额都走自己的上游端点」守（核对 zcode 的
    //    `/api/v1/zcode-plan/billing/balance` 真的被请求到）。
    expect(descriptorOf(ZCODE.id)?.credits?.balance, 'zcode 应声明余额能力').toBe(true)
  })

  it('★ zcode 的签到能力（registry 判据）：可签到、且登记为「自动签到有代价」', () => {
    const zcode = descriptorOf(ZCODE.id)
    expect(zcode?.credits?.dailyCheckin, 'zcode 应声明可签到').toBe(true)
    expect(zcode?.autoCheckinExcluded, 'zcode 必须被排除出自动签到').toBe(true)
    // ⚠️ claimAll 侧的行为由 `claim-runtime-parity.spec.ts`
    //    的「豁免者 zcode 真的能签到（真跑端点）」守 —— 见上方说明。
  })

  it('index.ts 把 zcode 接进 registerJetHubRpc 与 modelAdapters', () => {
    const source = readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8')
    // ⚠️ 2026-10-08 改：原先这里断言
    //    `/registerJetHubRpc\(ctx, pool, service, .*raccoon,.*zcode,.*gemini, modelAdapters\)/`
    //    —— 那是**位置参数**时代的源码文本断言，13 个形参改成**命名对象**后
    //    必然变红，而它守的意图（zcode 没接错实例）**与位置无关**。
    //    ⇒ 行为断言搬到了唯一一处（避免同一套 RPC 夹具在多文件重复）：
    //    `tests/unit/jet-hub-rpc-auth-wiring.spec.ts` 的
    //    「★★ 每个 provider id 的续期都分派到自己的 auth 实例」—— 它真跑
    //    `apply()` + `account.refresh`，逐个 provider 核对**哪个实例**被调用。
    //    **比原断言更强**：文本断言只能证明源码里有那串字符，它能证明端到端
    //    分派真的落到 zcode 自己的实例上。
    // ⚠️ 2026-10-06 复审 !66：登记项经 `pruned(...)` 包装（致命缺陷修复之一）。
    expect(source).toMatch(/zcode: pruned\([^)]*,\s*zcodeAdapter\)/)
  })

  it('★ index.ts 的清理块会 dispose captcha 浏览器（否则留孤儿 chromium）', () => {
    const source = readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8')
    const disposals = [...source.matchAll(/zcodeAdapter\.stop\(\)/g)]
    // 两个 ctx.effect 清理块都要有。
    expect(disposals.length).toBeGreaterThanOrEqual(2)
  })

  it('zcode 声明了老契约需要的 settings namespace（行为断言，2026-10-08 改）', () => {
    // ⚠️ 2026-10-08 改：原先这里扫 `src/index.ts` 的源码文本找 `'llm-zcode'`。
    //    本次重构把 13 个字面量收敛成从 `PROVIDER_REGISTRY` 派生，字面量**搬了家**
    //    —— 文本断言于是变红，而行为完全没变。这正是本仓库红线说的「源码文本
    //    断言是错的工具」：它守不住行为，却会被无关重构打红。
    //    ⇒ 改为断言**声明值**；「index.ts 真的按它注册了」由
    //    `provider-registry-consumers.spec.ts` 的 `apply()` 行为用例守。
    expect(descriptorOf('zcode')?.settingsNamespace).toBe('llm-zcode')
  })

  /**
   * ★ **不变式**：客户端 `PROVIDERS` 里的每个 provider，要么在 `JetHubAuths`
   * 里有同名键，要么属于**两个被验证过的豁免**。
   *
   * ## ⚠️ 2026-10-08 改：原先两条用例断言的是「位置参数的**个数**」
   *
   * 旧形态用正则解析 `registerJetHubRpc` 的签名，断言
   * `params.length === clientIds.length + 1` 且「不占形参位的是 opencode 与
   * aggregate」。13 个形参改成**命名对象**后，签名只剩 4 个形参
   *（`ctx, pool, auths, modelAdapters`）⇒ 那两条必然变红。
   *
   * 而它们守的意图**仍然成立且更重要**：「客户端多了一个面板、服务端却没接线」
   * 必须被发现。命名对象下判据从「数形参」变成**读键名** —— 键名即语义，
   * 于是这条不变式**比原来更强**：原断言只能发现「个数不对」，本条能逐个点名
   * 是**哪个** provider 漏了（`withoutKey` 会列出它）。
   *
   * ## 唯一的豁免：`opencode` 与 `aggregate`（两者理由**不同**）
   *
   * - `opencode`：RPC 由 `handleMethod` 统一分派到 `handleOpencodeRpc`，**不占键位**；
   * - `aggregate`：**没有 auth 服务**（无账号 / 无凭据 / 无续期）⇒ 它不该占一个
   *   `XxxAuth` 键，否则会逼每个调用点补一个占位。它的 RPC 走
   *   `modelAdapters['aggregate']`（P2）。
   *
   * ⚠️ 豁免本身必须被**验证**（下面第二条断言），否则「少接了一个」与
   * 「本来就该少一个」就分不开了。
   */
  it('★ 客户端每个 provider 都在 JetHubAuths 里有同名键（除两个被验证的豁免）', () => {
    const keys = jetHubAuthKeys()
    const clientIds = clientProviderIds()
    // ⚠️ 2026-10-12 加 officeace、2026-10-13 加 accio：15 → 17。
    // ⚠️ 2026-10-15 加 minimaxintl（MiniMax Code 国际版）：17 → 18。
    // ⚠️ 2026-10-16 加 astudio（goal 302 接线）：18 → 19。
    // ⚠️ 2026-10-17 加 autoclaw（AutoClaw/智谱）：19 → 20；
    //    同日 **本 fork** 加 modelscope（魔搭）：20 → 21；
    //    2026-10-20 加 autoclawintl（AutoClaw 国际版）：21 → 22。
    // ⚠️ 2026-10-19 **本 fork** 加 codely（Unity，UI 先行）：20 → 21。
    //    ⚠️ clientProviderIds() 是**客户端图标表**的 id 数，与 registry 口径不同 ——
    //    权威值以断言实测为准，注释里的加减号只是**历史沿革**，不要拿来推当前数字。
    // 2026-10-29 fork: qiniu + magicrew added -> 24 -> 25.
    // 2026-11-01 fork: magicrewintl（MagiCrew 国际版）added -> 25 -> 26.
    // 2026-11-02 fork: monkeycode -> 27；monkeycodeintl + baizhi -> 29.
    expect(clientIds.length).toBe(29)
    // ⚠️ **21 个 auth 键**（23 个客户端 id − opencode − aggregate）。
    //    ⚠️ 2026-10-22（A6）：codely **已接续期**（`CodelyAuth` 签名修正为单参
    //    `refreshAll(pool)`，并接入 `index.ts` 的 `auths`）⇒ 它不再是豁免项。
    // 2026-10-29 fork: qiniu + magicrew 接续期后 auth 键 21 -> 22 -> 23.
    // 2026-11-01 fork: magicrewintl（与国内站共用 `MagicrewAuth`）：23 -> 24.
    // 2026-11-02 fork: monkeycode（`MonkeycodeAuth`）：24 -> 25.
    // 2026-11-02: monkeycodeintl + baizhi 接入后 25 -> 27。
    expect(keys).toHaveLength(27)
    const withoutKey = clientIds.filter((id) => !keys.includes(id))
    expect([...withoutKey].sort()).toEqual(['aggregate', 'opencode'])
  })

  it('★ 不占键位的是 opencode 与 aggregate（豁免被验证，不是被假设）', () => {
    const keys = jetHubAuthKeys()
    const clientIds = clientProviderIds()
    // 客户端有它们
    expect(clientIds).toContain('opencode')
    expect(clientIds).toContain('aggregate')
    // 但 `JetHubAuths` 里没有它们 —— 且**只有**它们没有。
    // ⚠️ **不再需要别名表**：键是 provider id（`qodercn` 全小写），
    //    与客户端 `PROVIDERS` 的 id **逐字相同**。旧形态要维护
    //    `{ qodercn: 'qoderCn' }` 别名，正是因为那时形参名是变量名 ——
    //    那层别名本身就是「键与 id 不同名」这个缺陷的化石。
    const withoutKey = clientIds.filter((id) => !keys.includes(id))
    // ⚠️ 两者豁免理由**不同**（见上一条用例的注释）：opencode 是「RPC 走
    //    handleOpencodeRpc」、aggregate 是「没有 auth 服务」。
    //    ⚠️ **codely 已从本清单移出**（2026-10-22 A6）：它的 `CodelyAuth`
    //    之前不能接是因为**契约都没对上**（`refreshAll` 是 2 参 ⇒ TS2322），
    //    而不是「不需要续期」。
    //    断言写成数组（而非 `toHaveLength(2)`）是为了在**将来多出豁免**时
    //    立刻可见是哪几个。
    expect([...withoutKey].sort()).toEqual(['aggregate', 'opencode'])
  })
})

describe('ZCode 与既有 provider 的约定一致性', () => {
  it('所有 auth 服务都 extends Service（zcode 不能是例外）', () => {
    const files = [
      'zcode-auth.ts', 'raccoon-auth.ts', 'loomy-auth.ts',
      'qoder-auth.ts', 'trae-auth.ts', 'cline-auth.ts',
    ]
    for (const file of files) {
      const source = readFileSync(resolve(HERE, '../../src', file), 'utf8')
      expect(source, file).toMatch(/extends Service/)
    }
  })

  it('refreshable 恒为 false（ZCode 没有 refresh 端点）', async () => {
    const { ZCODE_REFRESHABLE } = await import('../../src/zcode.js')
    expect(ZCODE_REFRESHABLE).toBe(false)
  })

  it('isZcodeExpired 恒为 false（JWT 无 exp，真失效由上游 401 反映）', async () => {
    const { isZcodeExpired } = await import('../../src/zcode.js')
    expect(isZcodeExpired({ zcode_jwt: 'x', device_mid: 'm' })).toBe(false)
  })

  /**
   * ⚠️ 这条用例**被反转了**，因为原结论是错的。
   *
   * 原断言守的是「适配器显式拒绝图片（该通道未验证）」。
   * 真相：用户实测 ZCode IDE 里同一模型能**正确理解图片**，
   * 而我们的实现**根本没有图片代码** —— 所谓「通道未验证」是误判。
   *
   * 现在守的是**正向能力**：图片存在且给了 `readImage` 时，
   * 适配器**必须真的把图片转发出去**（而不是丢弃或报错）。
   */
  it('★ 适配器支持图片（把 attachment 读成 data URL 并下发）', async () => {
    const { ZcodeAdapter } = await import('../../src/zcode-adapter.js')
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
    let sentBody = ''
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => ({ zcode_jwt: 'a.b.c', device_mid: 'm' }),
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      // ⚠ 模拟附件服务：把 attachmentId 读成字节。
      readImage: async () => ({ data: jpegBytes, mediaType: 'image/jpeg' }),
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        sentBody = String(init?.body ?? '')
        // 空的 SSE 会让消费器抛 EMPTY_RESPONSE —— 但我们只关心**已发出的请求体**。
        return new Response(
          'event: message_start\ndata: {"type":"message_start"}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }) as never,
    })
    for await (const _chunk of adapter.stream({
      provider: 'zcode',
      model: 'GLM-5.3-Flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '描述这张图' },
          // ⚠ DSH 的真实形态：只带 attachment 引用。
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ],
      }],
    } as never)) { /* 消费掉 */ }

    // ★ 请求体里必须出现 Anthropic 形态的图片块。
    expect(sentBody).toContain('"type":"image"')
    expect(sentBody).toContain('"type":"base64"')
    expect(sentBody).toContain('"media_type":"image/jpeg"')
    // 且必须是真实的 base64 字节（/9j/ 是 JPEG 的 base64 开头）。
    expect(sentBody).toContain('/9j/')
    // 不能退化成占位符。
    expect(sentBody).not.toContain('image unavailable')
  })

  it('★ 有图片但宿主没给 readImage 时 → 明确报错（不静默丢图）', async () => {
    const { ZcodeAdapter } = await import('../../src/zcode-adapter.js')
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => ({ zcode_jwt: 'a.b.c', device_mid: 'm' }),
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      fetchImpl: (async () => new Response('', { status: 200 })) as never,
    })
    const iterate = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'zcode',
        model: 'GLM-5.3-Flash',
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
      } as never)) { /* 不应有任何产出 */ }
    }
    // ⚠️ 明确报错比静默丢图好 —— 这条设计在排查图片链路时省了时间
    //（它把「没接」和「接了但坏了」分开了）。
    await expect(iterate()).rejects.toThrow(/附件服务/)
  })
})
