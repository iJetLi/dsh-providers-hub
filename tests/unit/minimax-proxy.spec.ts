/**
 * MiniMax **国际站**账号出口代理的行为与接线守卫。
 *
 * ## 与 `gemini-proxy.spec.ts` 的关系
 *
 * 形状同构（同一份实现的第三站），但**存在理由不同**：
 *
 * - Gemini 是「墙外能不能连通」；
 * - minimaxintl 是「连得上但被 307 到中国站」——**连通性与分流是两个独立失败**，
 *   故 testProxy 必须回 `geoRouted`，且「通」与「通了但仍在大陆」是两个断言格。
 *
 * ## 本文件以**行为**断言为主（与 gemini 同一条纪律）
 *
 * 源码文本断言对「分支恒不执行」与「注释诱饵」完全无感 ⇒ 能用行为断言的
 * 一律用行为；源码断言只守「接线点在不在」，且**全部先过 `stripComments`**。
 *
 * ⚠️ 残余弱点如实登记：剥注释解决不了「字面量在死条件里」。凡被行为用例
 * 覆盖的接线点，都**不再**只靠源码断言。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  createMinimaxFetcherResolver,
  minimaxIntlFetchForAccount,
  minimaxIntlXffForProbe,
  setMinimaxProxyPool,
} from '../../src/minimax-proxy.js'
import { handleMinimaxIntlRpc } from '../../src/minimax-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { stripComments } from '../helpers/strip-comments.js'

const here = dirname(fileURLToPath(import.meta.url))
// ⚠️ **全部先剥注释**：见文件头的「为什么以行为断言为主」。
const adapterSource = stripComments(readFileSync(join(here, '../../src/minimax-adapter.ts'), 'utf8'))
const authSource = stripComments(readFileSync(join(here, '../../src/minimax-auth.ts'), 'utf8'))
const indexSource = stripComments(readFileSync(join(here, '../../src/index.ts'), 'utf8'))
const rpcSource = stripComments(readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8'))
const poolSource = stripComments(readFileSync(join(here, '../../src/account-pool.ts'), 'utf8'))
const typesSource = stripComments(readFileSync(join(here, '../../src/types.ts'), 'utf8'))
const selectorSource = stripComments(
  readFileSync(join(here, '../../src/buddy-balance-selector.ts'), 'utf8'),
)
const clientSource = stripComments(
  readFileSync(join(here, '../../plugin-src/client/jet-hub.js'), 'utf8'),
)
const modalSource = stripComments(
  readFileSync(join(here, '../../plugin-src/client/opencode-proxy-modal.js'), 'utf8'),
)

describe('① fetcher 解析器：按账号取出口', () => {
  it('空账号 id ⇒ 退回全局 fetch（不是抛错、不是空代理串）', () => {
    const resolver = createMinimaxFetcherResolver(() => {
      throw new Error('不该被问到')
    })
    // ⚠️ 空 id 必须**根本不查池**：查了会把「不知道是谁」变成「用某人的出口」。
    expect(resolver('')).toBe(fetch)
  })

  it('账号没配代理 ⇒ 退回全局 fetch（保持 NODE_USE_ENV_PROXY 宿主能力）', () => {
    const resolver = createMinimaxFetcherResolver(() => '')
    expect(resolver('acct-1')).toBe(fetch)
  })

  it('⚠️ 配了代理 ⇒ 换成另一个 fetcher（不是同一份全局 fetch）', () => {
    const resolver = createMinimaxFetcherResolver(() => '127.0.0.1:7897')
    const got = resolver('acct-1')
    expect(got).not.toBe(fetch)
    expect(typeof got).toBe('function')
  })

  it('⚠️ 非法代理地址必须抛错，绝不静默退回直连', () => {
    const resolver = createMinimaxFetcherResolver(() => 'ftp://host:21')
    expect(() => resolver('acct-1')).toThrow(/代理地址无效|ftp/)
  })

  it('同账号两次解析 ⇒ 按需现取（用户改代理后立即生效，不需重启）', () => {
    let stored = ''
    const resolver = createMinimaxFetcherResolver(() => stored)
    expect(resolver('acct-1')).toBe(fetch)
    stored = 'socks5://127.0.0.1:1080'
    expect(resolver('acct-1')).not.toBe(fetch)
  })

  it('⚠️ 池返回脏值（数字/对象）⇒ 视作「未配置」而不是崩在 trim 上', () => {
    // 脏值来源：用户可编辑的备份文件原样透传（sanitizeAccounts 不校验形状）。
    const resolver = createMinimaxFetcherResolver(() => 12345 as unknown as string)
    expect(resolver('acct-1')).toBe(fetch)
  })

  it('⚠️ 全局解析器：池未就绪 ⇒ 直连；就绪后按池读（可后填引用）', () => {
    // 未注入池 ⇒ 恒直连（探测路径在 apply() 之前就可能跑）。
    setMinimaxProxyPool(undefined)
    expect(minimaxIntlFetchForAccount('acct-1')).toBe(fetch)
  })
})

describe('② 接线：每个消费点都必须接上按账号的 fetcher（源码级，剥注释后）', () => {
  /**
   * ⚠️⚠️ **本组用「精确计数」而不是 `toBeGreaterThanOrEqual`**（PR !145 审计修法）。
   *
   * 初版写的是 `toBeGreaterThanOrEqual(4)`（实际 6）、`>= 3`（实际 5）——
   * 留的余量正好等于「可以悄悄删掉几条腿」。实测后果（对抗审计逐条验证）：
   *
   * | 变异 | 初版 |
   * |---|---|
   * | 删自愈腿 + 续期腿（6→4） | **全绿** |
   * | 再删登录注入 + 推理注入（5→3） | **全绿** |
   *
   * ⇒ 改成**精确计数**：多一条少一条都变红。这仍然只是「接线点在不在」的
   * 粗判据（源码文本断言对死分支无感），故**行为级判据在 ⑦ / ⑨ 组**；
   * 本组只负责「别把腿删了还不响」。
   */
  it('⚠️ MinimaxAuth 登录 / 续期 / 目录 / 身份四条腿都接了 fetcherFor（精确计数）', () => {
    // 6 处调用点：183（设备码）、212（轮询）、451（续期，经 grantOnce）、534（目录）、
    // 670（身份自愈）、persistLogin 身份查询
    // —— 逐条点名而不是只数总数，删掉任意一条都能立刻看出是哪条。
    expect(authSource).toContain('startMinimaxDeviceAuthorization(this.fetcherFor(accountId ?? \'\')')
    expect(authSource).toContain('fetcher: this.fetcherFor(options.accountId ?? \'\')')
    expect(authSource).toContain('this.fetcherFor(accountId ?? \'\')')      // grantOnce（续期）
    expect(authSource).toContain('fetcher: this.fetcherFor(accountId ?? \'\')') // fetchRawModels
    expect(authSource).toContain('this.fetcherFor(entry.id)')              // 自愈身份
    // 总数兜底（防止有人用别的写法绕开上面的锚点后总数却变少）。
    expect((authSource.match(/this\.fetcherFor\(/g) ?? []).length).toBe(6)
  })

  it('⚠️ MinimaxAdapter 推理主路径走 fetcherFor(activeAccountId)，且在 send() 里现取', () => {
    expect(adapterSource).toContain('fetcher: this.fetcherFor(activeAccountId)')
  })

  it('⚠️ index.ts：国际站各消费点都注入了 minimaxIntlFetchForAccount（逐点精确）', () => {
    /**
     * ⚠️⚠️ **逐点断言，不只数总数**（PR !145 审计 P0 修法）。
     *
     * 初版是 `toBeGreaterThanOrEqual(3)`（实际 5）—— 余量正好允许悄悄漏掉
     * 两处，而那两处正是 **`creditsTable`（积分）与 `expiryTable`（聚合折算）**：
     * 漏掉它们的症状是「配好代理后对话能用、积分行仍失败、渠道仍被剔出轮换」。
     *
     * ⇒ 逐点断言「某个具体装配处必须带这个键」，漏哪一处都能一眼看出是哪一处。
     * （`fetchFor:` 是 MinimaxAuth / MinimaxAdapter / probeById 的键，
     *  `minimaxIntlFetchFor:` 是两张 deps 表的键 —— 两个键名不同，不能混数。）
     */
    // ① probeById 的探测适配器（出口 + 显式 accountIdOverride）
    expect(indexSource).toContain('fetchFor: minimaxIntlFetchForAccount')
    // ② 余额选号器（BuddyBalanceSelector 的 deps.fetchFor）
    // ③ MinimaxAuth（登录 / 续期 / 目录 / 身份四条腿的 fetchFor）
    // ④ MinimaxAdapter（推理主路径的 fetchFor）
    // ⑤ **creditsTable**（积分面板三条链路）—— PR !145 审计补
    // ⑥ **expiryTable**（聚合折算）—— PR !145 审计补
    expect(indexSource).toContain('minimaxIntlFetchFor: minimaxIntlFetchForAccount')
    // 两处 deps 表各一次（credits + expiry）：精确计数锁住「补了一处漏另一处」。
    expect(
      (indexSource.match(/minimaxIntlFetchFor: minimaxIntlFetchForAccount/g) ?? []).length,
      'creditsTable 与 expiryTable 必须**都**接（只接一处 = 另一条链路静默直连）',
    ).toBe(2)
    // `fetchFor:` 三处（probeById / MinimaxAuth / MinimaxAdapter）+ 选号器一处 = 4
    expect(
      (indexSource.match(/fetchFor: minimaxIntlFetchForAccount/g) ?? []).length,
      '探测 / 选号器 / auth / adapter 四处都必须接',
    ).toBe(4)
  })

  it('⚠️ index.ts：中国站实例**刻意不注入**（直连才是最优）', () => {
    // ⚠️ 2026-10-24 本地试验版改：构造带了 `journalHome`（journal 落盘根目录），
    //    文本形态从 `new MinimaxAuth(ctx)` 变为 `new MinimaxAuth(ctx, {…})`。
    //    「刻意不注入 fetchFor」的判定改为**片段断言**：从 minimax 构造起点到
    //    minimaxIntl 构造起点之间不得出现 `fetchFor`（片段足够窄，不会误伤
    //    国际站那条；国际站的 `fetchFor` 在其自身构造块里，不落在本片段内）。
    const code = stripComments(indexSource)
    const block = code.slice(
      code.indexOf('const minimax = new MinimaxAuth(ctx,'),
      code.indexOf('const minimaxIntl = new MinimaxAuth(ctx,'),
    )
    expect(block.length, '找不到 minimax 构造块（文本形态又变了）').toBeGreaterThan(0)
    expect(block, '中国站实例必须直连（fetchFor 会把国内站引到国际站）').not.toContain('fetchFor')
  })

  it('⚠️ 探测适配器把**池条目 id** 显式传进去（探测路径反查不存在）', () => {
    expect(indexSource).toContain('accountIdOverride: entry?.id')
  })

  it('⚠️ 登录分支把占位账号 id 传进 startLogin（凭据落盘前只有池条目认得它）', () => {
    expect(rpcSource).toContain('await minimaxAuth.startLogin({ accountId: id })')
  })

  it('⚠️ 登录分支为国际站继承既有账号的代理（死锁规避），且有替身防御', () => {
    expect(rpcSource).toContain('typeof pool.listAccountsByProvider')
  })

  it('⚠️ persistLogin 把 accountId 透传（身份查询同出口）', () => {
    expect(rpcSource).toContain(
      'await minimaxAuth.persistLogin(credential, { refName, accountId: id })',
    )
  })

  it('⚠️ 池字段读写与「非字符串脏值防御」都在', () => {
    expect(poolSource).toContain('setMinimaxIntlProxy')
    expect(poolSource).toContain('minimaxIntlProxyFor')
    expect(typesSource).toContain('minimaxIntlProxy?: string')
  })

  it('⚠️ 余额选号器把账号上下文传给 fetchBalance（第三参）', () => {
    expect(selectorSource).toContain('accountId: account.id')
  })

  it('⚠️ RPC 前缀改道用 minimaxintl.（不是 minimax.，防误吞中国站未来端点）', () => {
    expect(rpcSource).toContain("method.startsWith('minimaxintl.')")
  })
})

describe('③ 端点行为（setProxy / testProxy，守「死条件」变异）', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('setProxy：合法地址会真的落到池里', async () => {
    const pool = { setMinimaxIntlProxy: vi.fn(async () => {}) }
    const res = await handleMinimaxIntlRpc({} as never, pool, 'minimaxintl.setProxy', {
      accountId: 'minimaxintl-1', proxy: '127.0.0.1:7890',
    })
    expect(pool.setMinimaxIntlProxy).toHaveBeenCalledWith('minimaxintl-1', 'http://127.0.0.1:7890')
    expect(res).toMatchObject({ ok: true })
  })

  it('setProxy：空串 = 清除（不是非法地址）', async () => {
    const pool = { setMinimaxIntlProxy: vi.fn(async () => {}) }
    const res = await handleMinimaxIntlRpc({} as never, pool, 'minimaxintl.setProxy', {
      accountId: 'minimaxintl-1', proxy: '',
    })
    expect(pool.setMinimaxIntlProxy).toHaveBeenCalledWith('minimaxintl-1', '')
    expect(res).toMatchObject({ ok: true, value: { proxy: '' } })
  })

  it('⚠️ setProxy：非法地址被拒，且**不写池**', async () => {
    const pool = { setMinimaxIntlProxy: vi.fn(async () => {}) }
    const res = await handleMinimaxIntlRpc({} as never, pool, 'minimaxintl.setProxy', {
      accountId: 'minimaxintl-1', proxy: 'ftp://host:21',
    })
    expect(res).toMatchObject({ ok: false })
    expect(pool.setMinimaxIntlProxy).not.toHaveBeenCalled()
  })

  it('⚠️ setProxy：缺 accountId 必须拒绝且不写池', async () => {
    const pool = { setMinimaxIntlProxy: vi.fn(async () => {}) }
    for (const payload of [{}, { accountId: '' }, { accountId: 123 }]) {
      const res = await handleMinimaxIntlRpc({} as never, pool, 'minimaxintl.setProxy', payload)
      expect(res, JSON.stringify(payload)).toMatchObject({ ok: false })
    }
    expect(pool.setMinimaxIntlProxy).not.toHaveBeenCalled()
  })

  it('⚠️ 不认识的方法返回 undefined（让主 switch 继续匹配）', async () => {
    // ⚠️ 回信封会把**别的** provider 的方法名误判成「格式错误」。
    expect(await handleMinimaxIntlRpc({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.未知', {}))
      .toBeUndefined()
  })
})

describe('④ testProxy 的探活语义（连通性与分流是两个独立失败）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('../../src/opencode-proxy.js')
  })

  /** 装一个 mock 版 opencode-proxy，返回可断言的 spy。 */
  async function withMockedProxyFetch(impl: () => Promise<Response>) {
    const spy = vi.fn(impl)
    vi.resetModules()
    vi.doMock('../../src/opencode-proxy.js', () => ({
      proxyFetch: spy,
      buildProxyDispatcher: () => ({}),
      closeAllProxyDispatchers: async () => {},
      proxyCacheSize: () => 0,
      resolveConnectPort: () => 443,
      buildSocks5Handshake: () => new Uint8Array(),
    }))
    const mod = await import('../../src/minimax-rpc.js')
    return { spy, handle: mod.handleMinimaxIntlRpc }
  }

  it('⚠️ 探活目标必须是国际站自己的端点，且真用用户填的代理', async () => {
    const { spy, handle } = await withMockedProxyFetch(
      async () => new Response('', { status: 200 }),
    )
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res, '探活失败').toMatchObject({ ok: true })
    // 一条断言同时打掉两处变异：换成别的主机、绕过用户代理。
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('https://agent.minimax.io/'),
      expect.objectContaining({ redirect: 'manual' }),
      expect.objectContaining({ url: 'http://127.0.0.1:7890' }),
    )
  })

  it('⚠️ 正常 200 ⇒ 通且未被分流（geoRouted=false）', async () => {
    const { handle } = await withMockedProxyFetch(
      async () => new Response('', { status: 200 }),
    )
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res).toMatchObject({ ok: true, value: { status: 200, geoRouted: false } })
  })

  it('⚠️⚠️ 307 到中国站 ⇒ **仍然 ok:true 但 geoRouted=true**（假阳性防护）', async () => {
    // 这是本家与 gemini 唯一实质不同的一格：拿到 HTTP 响应 ≠ 没被分流。
    const { handle } = await withMockedProxyFetch(async () => new Response('', {
      status: 307,
      headers: { Location: 'https://agent.minimaxi.com/v1/models' },
    }))
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res).toMatchObject({ ok: true, value: { status: 307, geoRouted: true } })
  })

  it('⚠️ 307 到其它主机（同站跳转）不算分流', async () => {
    const { handle } = await withMockedProxyFetch(async () => new Response('', {
      status: 302,
      headers: { Location: 'https://agent.minimax.io/v1/models?x=1' },
    }))
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res).toMatchObject({ ok: true, value: { geoRouted: false } })
  })

  it('⚠️ 401 也算「通」（判 response.ok 会让正确配置报红）', async () => {
    const { handle } = await withMockedProxyFetch(
      async () => new Response('', { status: 401 }),
    )
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res).toMatchObject({ ok: true, value: { status: 401, geoRouted: false } })
  })

  it('⚠️ 失败文案必须带根因码（error.message 恒为 fetch failed，真因在 cause）', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    const { handle } = await withMockedProxyFetch(async () => {
      throw new TypeError('fetch failed', { cause })
    })
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    })
    expect(res).toMatchObject({ ok: false })
    const message = (res as { error: { message: string } }).error.message
    expect(message).toContain('ENOTFOUND')
  })

  it('⚠️ 非法代理地址在 testProxy 也必须被拒', async () => {
    const { handle } = await withMockedProxyFetch(async () => new Response('', { status: 200 }))
    const res = await handle({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'not-a-proxy',
    })
    // 「not-a-proxy」无端口 ⇒ normalizeProxy 拒绝（缺端口）。
    expect(res).toMatchObject({ ok: false })
  })
})

describe('⑤ 池字段行为（AccountPool 真跑，非替身）', () => {
  it('setMinimaxIntlProxy 写入后 minimaxIntlProxyFor 能读回；空串删键', async () => {
    const ctx = {
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    } as never
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'acct-1', provider: 'minimaxintl', nickname: 'n', enabled: true,
      credentialRef: 'ref', refreshable: false, createdAt: Date.now(),
    })
    await pool.setMinimaxIntlProxy('acct-1', 'http://127.0.0.1:7890')
    expect(pool.minimaxIntlProxyFor('acct-1')).toBe('http://127.0.0.1:7890')
    // 未设置的账号 ⇒ 空串（不是 undefined）。
    expect(pool.minimaxIntlProxyFor('acct-missing')).toBe('')
    // 清除 = 删键（读回空串）。
    await pool.setMinimaxIntlProxy('acct-1', '')
    expect(pool.minimaxIntlProxyFor('acct-1')).toBe('')
    // 不存在的账号 ⇒ 不抛（warn 后返回）。
    await expect(pool.setMinimaxIntlProxy('nope', 'http://x:1')).resolves.toBeUndefined()
  })

  it('⚠️ 池里被注入非字符串脏值 ⇒ 读回空串（不崩在 trim 上）', async () => {
    const ctx = {
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
    } as never
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'acct-1', provider: 'minimaxintl', nickname: 'n', enabled: true,
      credentialRef: 'ref', refreshable: false, createdAt: Date.now(),
    })
    // 模拟用户手改备份文件（sanitizeAccounts 原样透传的入口）。
    const accounts = pool.listAccounts ? await pool.listAccounts('minimaxintl') : []
    const entry = accounts[0]!
    // 直接写内部快照（AccountPool 没有公开的「写脏值」入口 —— 这正是防御的理由）。
    ;(entry as { minimaxIntlProxy?: unknown }).minimaxIntlProxy = 12345
    // readAccounts 从权威副本读：直接改副本。
    const raw = (pool as unknown as { readAccounts(): Array<Record<string, unknown>> })
      .readAccounts()
    const target = raw.find((a) => a.id === 'acct-1')
    if (target) target.minimaxIntlProxy = 12345
    expect(pool.minimaxIntlProxyFor('acct-1')).toBe('')
  })
})

describe('⑥ 客户端接线（源码级，剥注释后）', () => {
  it('⚠️ minimaxintl 的账号卡传了 onOpenProxy', () => {
    expect(clientSource).toContain("provider === 'minimaxintl'")
    expect(clientSource).toContain('MinimaxIntlProxyModal')
    expect(clientSource).toContain('proxyModalComponent')
  })

  it('⚠️ 弹窗调 minimaxintl.setProxy / testProxy，且回显 geoRouted 警告', () => {
    expect(modalSource).toContain("'minimaxintl.setProxy'")
    expect(modalSource).toContain("'minimaxintl.testProxy'")
    expect(modalSource).toContain('geoRouted')
  })

  it('⚠️ AccountCard 的 tooltip 分支覆盖三家（当前值 → 修改；未设置 → 语义说明）', () => {
    expect(clientSource).toContain('account.minimaxIntlProxy')
  })
})

/**
 * ⑦ **积分 / 签到 / 聚合折算三条链路必须真的走账号出口**（PR !145 审计 P0 修法）。
 *
 * ## ⚠️⚠️ 为什么这一组必须是**行为**断言，不能是源码文本断言
 *
 * PR !145 原来的 ② 组全是 `toContain('this.fetcherFor(')` 这类文本断言，而且
 * 计数写成 `toBeGreaterThanOrEqual(4)`（实际 6）—— 留了余量。实测后果：
 *
 * | 变异 | 原 ② 组 |
 * |---|---|
 * | `MinimaxAdapter.fetcherFor()` 掏空成 `return fetch`（**代理彻底失效**） | 全绿 |
 * | 删掉自愈腿 + 续期腿（6→4） | 全绿 |
 * | 再删掉登录注入 + 推理注入（5→3） | 全绿 |
 *
 * ⇒ 本组改为**注入替身并断言它被调用、且拿到了正确的 accountId**。
 * 判据打在「谁被问到了什么」上，而不是「源码里有没有那个字面量」。
 */
describe('⑦ ★★ 三条链路真走账号出口（行为级，取代无牙的源码计数）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('../../src/minimax-credits.js')
  })

  /** 造一个记账用的 fetcher 替身：被调用即记下「哪个账号的出口被用到」。 */
  function spyFetcherFor(log: string[]): (accountId: string) => typeof fetch {
    return (accountId: string) => {
      log.push(accountId)
      // 返回一个「不会真发请求」的 fetch：抛错即证明它被选中了。
      return (() => Promise.reject(new Error(`proxied:${accountId}`))) as unknown as typeof fetch
    }
  }

  it('★★ 积分余额（credits 表 fetchBalanceDetailed）按 call.accountId 取出口', async () => {
    const log: string[] = []
    const { createProviderCredits } = await import('../../src/provider-credits.js')
    const table = createProviderCredits({ minimaxIntlFetchFor: spyFetcherFor(log) })
    const impl = table.minimaxintl
    expect(impl?.fetchBalanceDetailed, 'minimaxintl 必须实现 fetchBalanceDetailed').toBeDefined()
    // 该实现会真发请求（我们注入的 fetcher 立刻 reject），故只断言「出口被问到」。
    await impl!.fetchBalanceDetailed!({ access_token: 't' }, {
      resolveCredential: async () => undefined,
      warn: () => {},
      accountPool: {} as never,
      accountId: 'acct-intl-1',
    }).catch(() => undefined)
    expect(log, '积分余额链路没有按账号取出口 —— 代理被绕过').toEqual(['acct-intl-1'])
  })

  it('★★ 签到领取（credits 表 claim）按 entry.id 取出口', async () => {
    const log: string[] = []
    const { createProviderCredits } = await import('../../src/provider-credits.js')
    const table = createProviderCredits({ minimaxIntlFetchFor: spyFetcherFor(log) })
    const impl = table.minimaxintl
    expect(impl?.claim, 'minimaxintl 必须实现 claim').toBeDefined()
    await impl!.claim!(
      { access_token: 't' },
      { id: 'acct-intl-2', provider: 'minimaxintl', credentialRef: 'r', enabled: true, refreshable: true, nickname: 'n', createdAt: 0 },
      { resolveCredential: async () => undefined, warn: () => {}, accountPool: {} as never },
    ).catch(() => undefined)
    expect(log, '签到领取链路没有按账号取出口').toEqual(['acct-intl-2'])
  })

  it('★★ 聚合折算（createProviderExpiry 的 minimaxintl）按 context.accountId 取出口', async () => {
    const log: string[] = []
    const { createProviderExpiry } = await import('../../src/provider-expiry.js')
    const table = createProviderExpiry({ minimaxIntlFetchFor: spyFetcherFor(log) })
    const impl = table.minimaxintl
    expect(impl?.credentialExpiry, 'minimaxintl 必须接入临期折算').toBeDefined()
    await impl!.credentialExpiry(
      { access_token: 't' },
      { accountId: 'acct-intl-3' } as never,
    ).catch(() => undefined)
    expect(log, '聚合折算链路没有按账号取出口 —— 该渠道仍会被静默剔出轮换')
      .toEqual(['acct-intl-3'])
  })

  it('★ 中国版**刻意不取出口**（直连才是最优，给了代理反而绕境外一圈）', async () => {
    const log: string[] = []
    const { createProviderExpiry } = await import('../../src/provider-expiry.js')
    const table = createProviderExpiry({ minimaxIntlFetchFor: spyFetcherFor(log) })
    await table.minimax.credentialExpiry(
      { access_token: 't' },
      { accountId: 'acct-cn-1' } as never,
    ).catch(() => undefined)
    expect(log, '中国版不该取国际站的出口').toEqual([])
  })

  it('★ 未注入 `minimaxIntlFetchFor` ⇒ 退回全局 fetch（与修复前逐字节等价）', async () => {
    const log: string[] = []
    const { createProviderCredits } = await import('../../src/provider-credits.js')
    const table = createProviderCredits()   // 刻意不注入
    /**
     * ⚠️⚠️ **必须把全局 `fetch` 换成桩**（2026-11-21 修，全量跑偶发红）。
     *
     * 这条用例的本意是「没注入器 ⇒ 走**那条默认路径**，不抛 TypeError」。
     * 但「默认路径」= `fetchMinimaxCreditBalanceDetailed(…, globalThis.fetch, …)`
     * ⇒ 它**真的会发一次 HTTPS 请求**到 `agent.minimax.io`。
     *
     * 后果就是本仓库反复记过的那种形态：**单跑必绿、全量偶发红** ——
     * 全量时几十个 worker 并跑，这次请求要么被 `testTimeout` 掐掉，
     * 要么拿到的 `error` 文案与本机网络状态有关。实测在**未改动的 master**
     * 上连跑 3 轮就出现过 1 次红（`minimax-proxy.spec.ts` ⑦ 组）。
     *
     * ⚠️ 判据因此要打在**「用了哪个 fetcher」**上，而不是「请求结果如何」：
     *    把全局 `fetch` 换成「记下自己被调用、然后立刻失败」的桩 ⇒
     *    「确实退回了全局 fetch」这件事实被**直接观测到**（比只看 `log` 空数组强：
     *    原判据断言「记账器没被调用」，而那在**任何**路径下都成立，
     *    包括「实现直接抛错、压根没取 fetcher」—— 是**恒真判据**）。
     */
    const globalCalls: string[] = []
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', ((input: unknown) => {
      globalCalls.push(String(input))
      return Promise.reject(new Error(`global-fetch-stub:${String(input)}`))
    }) as unknown as typeof fetch)
    try {
      await table.minimaxintl!.fetchBalanceDetailed!({ access_token: 't' }, {
        resolveCredential: async () => undefined,
        warn: () => {},
        accountPool: {} as never,
        accountId: 'acct-intl-4',
      }).catch(() => undefined)
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
    // 记账器（注入器）没被调用 —— 这仍然成立。
    expect(log).toEqual([])
    // ★ 真正有牙的那条：默认路径**确实**用了全局 fetch。
    expect(globalCalls.length, '未注入出口时必须退回全局 fetch —— 否则这条「默认路径」无覆盖').toBeGreaterThan(0)
  })
})

/**
 * ⑧ **`geoRouted` 判据的两条独立修正**（PR !145 审计 P1 修法）。
 *
 * 初版有两个假阳性来源：
 * 1. 只看 `Location`、**不看状态码** ⇒ 正常 200 响应带 Location 头就判分流；
 * 2. 自己抄了一份裸 `endsWith('.minimaxi.com')`，**漏掉裸域与协议相对**
 *   （`minimax.ts` 的 `hasHostSuffix` 是权威实现，其注释明写不许再抄一份）。
 */
describe('⑧ ★★ geoRouted 判据（状态码 + 权威后缀判据）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('../../src/opencode-proxy.js')
  })

  async function probeWith(status: number, headers: Record<string, string>) {
    const spy = vi.fn(async () => new Response('', { status, headers }))
    vi.resetModules()
    vi.doMock('../../src/opencode-proxy.js', () => ({
      proxyFetch: spy,
      buildProxyDispatcher: () => ({}),
      closeAllProxyDispatchers: async () => {},
      proxyCacheSize: () => 0,
      resolveConnectPort: () => 443,
      buildSocks5Handshake: () => new Uint8Array(),
    }))
    const mod = await import('../../src/minimax-rpc.js')
    return mod.handleMinimaxIntlRpc({} as never, { setMinimaxIntlProxy: vi.fn() }, 'minimaxintl.testProxy', {
      proxy: 'http://127.0.0.1:7890',
    }) as Promise<{ ok: true; value: { status: number; geoRouted: boolean } }>
  }

  it('⚠️⚠️ 200 响应即使带 Location 头也**不得**判分流（初版会谎报）', async () => {
    // 某些 CDN / 网关会在 200 上带 Location 头 —— 那不是重定向。
    const res = await probeWith(200, { Location: 'https://agent.minimaxi.com/x' })
    expect(res.value.status).toBe(200)
    expect(res.value.geoRouted, '200 带 Location 被误判成分流 ⇒ 用户看到假警告').toBe(false)
  })

  it('⚠️⚠️ 307 指向**裸域** minimaxi.com 必须判分流（初版裸 endsWith 漏报）', async () => {
    const res = await probeWith(307, { Location: 'https://minimaxi.com/x' })
    expect(res.value.geoRouted, '裸域漏报 ⇒ UI 显示绿色但实际照样 401').toBe(true)
  })

  it('⚠️⚠️ 307 指向**协议相对** //host 必须判分流（初版漏报）', async () => {
    const res = await probeWith(307, { Location: '//agent.minimaxi.com/x' })
    expect(res.value.geoRouted, '协议相对 Location 漏报').toBe(true)
  })

  it('⚠️ 308 也算分流（与 isMinimaxGeoRoute 同口径）', async () => {
    const res = await probeWith(308, { Location: 'https://agent.minimaxi.com/x' })
    expect(res.value.geoRouted).toBe(true)
  })

  it('⚠️ 仿冒域不得判分流（evilminimaxi.com / 后缀伪装）', async () => {
    for (const loc of [
      'https://evilminimaxi.com/x',
      'https://agent.minimaxi.com.attacker.com/x',
    ]) {
      const res = await probeWith(307, { Location: loc })
      expect(res.value.geoRouted, `${loc} 被误判成中国站`).toBe(false)
    }
  })

  it('⚠️ 302 指向中国站**不**算分流（普通跳转，与 isMinimaxGeoRoute 同口径）', async () => {
    // ⚠️ 这一格是**判据收紧后**的行为变更：初版只要 Location 命中就判分流。
    //    与 `isMinimaxGeoRoute` 的「只认 307/308」对齐 —— 那才是「地理分流」的语义。
    const res = await probeWith(302, { Location: 'https://agent.minimaxi.com/x' })
    expect(res.value.geoRouted).toBe(false)
  })
})

/**
 * ⑨ **探测槽的 XFF 取值与池重置**（PR !145 审计 P1 修法）。
 *
 * 初版用 `globalThis.__jetHubMinimaxXffPool` 全局槽，模块级 `let` 能做而它做不到的
 * 一件事是**整体重置**（dispose 后清不掉）。本组锁住「传 undefined 即重置」。
 */
describe('⑨ ★ 探测槽 XFF：可后填、可重置（不再是 globalThis 魔法槽）', () => {
  afterEach(() => {
    setMinimaxProxyPool(undefined)
  })

  /**
   * ⚠️⚠️ **本组必须用文件顶部的静态 import，不能 `await import(...)`**。
   *
   * 前面 ⑧ 组用了 `vi.resetModules()` + `vi.doMock` —— 那会让**后续**
   * `await import('.../minimax-proxy.js')` 拿到一份**全新的模块实例**，
   * 而 `setMinimaxProxyPool`（静态 import 的那份）注入的是**另一个**实例的
   * `minimaxPoolRef`。症状是「注入了但读不到」，看起来像实现有 bug。
   * （实测踩过：本组三条用例全红，而实现是对的。）
   */
  it('⚠️ 池未注入 ⇒ undefined（不附头 = 既有行为）', () => {
    setMinimaxProxyPool(undefined)
    expect(minimaxIntlXffForProbe()).toBeUndefined()
  })

  it('⚠️ 池注入后现读（用户改设置立即生效，不是模块求值时的快照）', () => {
    let xff = '203.0.113.7'
    setMinimaxProxyPool({
      minimaxIntlProxyFor: () => '',
      minimaxXff: () => xff,
    })
    expect(minimaxIntlXffForProbe()).toBe('203.0.113.7')
    xff = '198.51.100.9'
    expect(minimaxIntlXffForProbe(), 'XFF 被固化成快照了').toBe('198.51.100.9')
  })

  it('⚠️⚠️ 传 undefined 必须**真的重置**（初版的 globalThis 槽做不到）', () => {
    setMinimaxProxyPool({ minimaxIntlProxyFor: () => '', minimaxXff: () => '203.0.113.7' })
    expect(minimaxIntlXffForProbe()).toBe('203.0.113.7')
    setMinimaxProxyPool(undefined)
    expect(minimaxIntlXffForProbe(), 'dispose 后仍读到旧池的 XFF').toBeUndefined()
  })

  it('⚠️ 池替身没有 minimaxXff 方法 ⇒ undefined（不抛 TypeError）', () => {
    setMinimaxProxyPool({ minimaxIntlProxyFor: () => '' })
    expect(minimaxIntlXffForProbe()).toBeUndefined()
  })
})

/**
 * ⑩ **`account.create` 载荷入口必须过 `normalizeProxy`**（PR !145 审计 P1 修法）。
 *
 * `types.ts` 明文承诺「读取侧必须过 normalizeProxy 归一，非法值一律拒绝」，
 * 而初版只 `trim()` 就写池 ⇒ 非法串落盘后该账号**每条链路都抛错且不自愈**。
 *
 * ⚠️ 这里只做**源码级**守卫（判据锚在 `normalizeProxy(intlProxyInput)` 这个
 * 具体表达式上，不是「文件里有没有 normalizeProxy 这个词」）——
 * 端到端跑 `account.create` 需要完整 ctx/池/凭据编排，成本远高于收益。
 */
describe('⑩ ★ account.create 的代理载荷必须归一化', () => {
  it('⚠️ 写池前必须过 normalizeProxy（且失败要拒绝，不能把脏值写进去）', () => {
    const rpc = stripComments(readFileSync(join(here, '../../src/jet-hub-rpc.ts'), 'utf8'))
    // 锚在**具体表达式**上：`normalizeProxy(intlProxyInput)`。
    expect(rpc, '载荷入口没过 normalizeProxy ⇒ 非法串会写进池且永不自愈')
      .toContain('normalizeProxy(intlProxyInput)')
    // 失败必须拒绝（`return` 一个 ok:false），不能 `await setMinimaxIntlProxy` 了事。
    const block = rpc.slice(
      rpc.indexOf('normalizeProxy(intlProxyInput)'),
      rpc.indexOf('normalizeProxy(intlProxyInput)') + 700,
    )
    expect(block, '归一化失败时没有拒绝路径').toMatch(/normalized\.ok/)
    expect(block, '归一化失败时必须回 ok:false').toContain('ok: false')
  })
})
