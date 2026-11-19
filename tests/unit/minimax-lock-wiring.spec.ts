/**
 * MiniMax Code（中国版 `minimax` / 国际版 `minimaxintl`）的
 * 「永久/长期/临期三档分档 + 锁定永久积分」**接线**回归。
 *
 * ## 为什么单独守这个（而不是复用 `buddy-permanent-lock.spec.ts` / `astudio-lock-wiring.spec.ts`）
 *
 * 那两份守的是「怎么建选号器」与「AStudio 那一条执行路径」。MiniMax 的缺陷是
 * **第三种形态**（2026-10-20 用户报障：「MiniMax Code积分也有到期时间，也应当有
 * 相同功能」）：
 *
 * 1. `fetchMinimaxCreditBalanceDetailed` 把 `packages` **硬编码成 `[]`** ——
 *    原注释的理由是「`details[]` 里没有区分『本周期有效』的标志（`credit_type`
 *    语义未实测），故不凭猜测分类」。⚠️ 该理由把**分类**与**到期时刻**混为一谈：
 *    到期时刻（`expire_at_ms`）每条明细**都直接下发**，无需猜 `credit_type`。
 *    后果：聚合侧把本家归为「查不到到期时间」⇒ 分档整体失效。
 * 2. `provider-registry.ts` 的 minimax 条目缺 `usesExpiryWindow`（分档行不渲染）
 *    与 `permanentLock`（锁定按钮不存在）—— 与 AStudio 首次报障同一个半残形态。
 * 3. `src/index.ts` 的注册段**不传 `balance`** ⇒ 走 `getAvailableAccount` 的
 *    「手动序第一个启用账号」，与到期时间无关 ⇒ 既无「临期优先」，也没有任何
 *    东西可供「锁定」判断 ⇒ 锁上了也不知道该不该拦。
 *
 * ## 判据分三层（由弱到强）
 *
 * 1. **源码接线**：`index.ts` 里确实建了两个选号器、确实各自接到工厂的
 *    `balance.selector`、确实传了 `lockedError`、国际站确实透传 `xff`。
 * 2. **registry 契约**：两站都 `permanentLock === true` 且 `usesExpiryWindow === true`。
 * 3. **分档行为**：把**真实上游报文形状**（`details[]` 每条带 `expire_at_ms`
 *    毫秒时间戳）喂给生产解析器 `fetchMinimaxCreditBalance`，再用
 *    `splitBuddyCreditsByExpiry` / `buddyBalanceTier` 验证「锁定后只剩长期积分
 *    ⇒ 该号不可用」。这一层驱动生产判据，不是复述实现。
 *
 * ⚠️ **不做**的事：不发真实网络（`fetcher` 全部注入假实现）、不读真实凭据。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'
import { fetchMinimaxCreditBalance } from '../../src/minimax-credits.js'
import {
  BUDDY_BALANCE_TIER,
  BUDDY_EXPIRING_WINDOW_DAYS,
  buddyBalanceTier,
  buddyTierUsable,
  splitBuddyCreditsByExpiry,
} from '../../src/buddy-balance-rank.js'
import { MINIMAX, MINIMAX_INTL } from '../../src/minimax-product.js'
import type { MinimaxCredential } from '../../src/minimax.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 接线断言不能因为「注释里提到了某个符号」就通过：本仓库注释大量解释
 * 「为什么不能走某条兜底」，对兜底的**否定**断言必须只看代码（与
 * `buddy-permanent-lock.spec.ts` 的 `codeOnly` 同一约定）。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
const indexCode = codeOnly(indexSource)

const CRED: MinimaxCredential = { access_token: 'a'.repeat(60), token_type: 'Bearer' }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * 真实 `/minimax-cloud/api/v1/credit/details` 的响应形状（2026-10-20 实测两账号）。
 *
 * ⚠️ `expire_at_ms` 是**毫秒时间戳**（不是秒、不是字符串）—— 与 astudio 的
 * `"2026-11-20T01:50:14"`（不带时区的本地时间串）是**两种形态**，本文件的
 * 行为层专门覆盖这一差异：MiniMax 侧**不做** `Date.parse` / 时区换算。
 */
function detailsPayload(expires: number[]): Record<string, unknown> {
  return {
    details: expires.map((expireAt, i) => ({
      granted_at_ms: expireAt - 30 * 86400_000,
      expire_at_ms: expireAt,
      credit_type: 2,
      granted_amount: '400.00',
      remaining_amount: '400.00',
      consumed_amount: '0.00',
      __i: i,
    })),
    total_count: expires.length,
    base_resp: { status_code: 0, status_msg: 'ok' },
  }
}

/** 造一个 `expire_at_ms` 落在指定天数后的响应，并走**生产解析器**拿余额。 */
async function balanceExpiringIn(days: number) {
  const fetcher = vi.fn().mockResolvedValue(json(detailsPayload([Date.now() + days * 86400_000])))
  const balance = await fetchMinimaxCreditBalance(CRED, fetcher as never)
  expect(balance, '生产解析器应产出余额').not.toBeNull()
  return balance!
}

describe('★ MiniMax：`permanentLock` / `usesExpiryWindow` 的 registry 契约', () => {
  it('两站都同时登记 permanentLock 与 usesExpiryWindow', () => {
    for (const id of ['minimax', 'minimaxintl']) {
      // 前者 ⇒ 客户端渲染「锁定/解锁」按钮 + `createCredentialResolver` 读 allowPermanent；
      // 后者 ⇒ `jet-hub-rpc.ts` 回传 `windowDays`（缺它 ⇒ 分档整体返回 null，静默）。
      expect(descriptorOf(id)?.permanentLock, `${id} 应支持锁定永久积分`).toBe(true)
      expect(descriptorOf(id)?.usesExpiryWindow, `${id} 应按到期分桶`).toBe(true)
    }
  })

  it('后端白名单（PERMANENT_LOCK_PROVIDERS）由 registry 派生且含两站', () => {
    // 直接钉住「派生关系」，而不是只断言成员 —— 有人手抄一份名单会在这里红。
    const derived = PROVIDER_REGISTRY.filter((d) => d.permanentLock === true).map((d) => d.id).sort()
    expect(derived).toContain('minimax')
    expect(derived).toContain('minimaxintl')
    expect([...PERMANENT_LOCK_PROVIDERS].sort()).toEqual(derived)
  })

  it('⚠️ 两站是**两个**渠道 id（共用一个 MinimaxAuth 不等于共用一个 id）', () => {
    // 只登记中国版会让国际站在聚合面板看到「请先登录」这句错话，
    // 且只登国际站的用户完全拿不到分档与锁定按钮。
    expect(MINIMAX.id).toBe('minimax')
    expect(MINIMAX_INTL.id).toBe('minimaxintl')
    expect(MINIMAX.id).not.toBe(MINIMAX_INTL.id)
  })
})

describe('★ MiniMax：`index.ts` 的接线（源码级，守纯文本形态的约定）', () => {
  it('两站各建一个选号器，且各自接到工厂的 balance.selector', () => {
    expect(indexCode).toMatch(
      /const minimaxBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: MINIMAX,/,
    )
    expect(indexCode).toMatch(
      /const minimaxIntlBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: MINIMAX_INTL,/,
    )
    // 建了不用 = 死代码，锁定仍无执行路径。
    expect(indexCode, '中国版的 balance.selector 必须指向 minimaxBalanceSelector')
      .toMatch(/selector:\s*minimaxBalanceSelector,/)
    expect(indexCode, '国际版的 balance.selector 必须指向 minimaxIntlBalanceSelector')
      .toMatch(/selector:\s*minimaxIntlBalanceSelector,/)
    // 国内站/国际站**不得**互换实例：误用会让国际站余额查询恒失败
    //（它不透传 xff ⇒ 被地理分流到中国站 ⇒ 该渠道在聚合轮换里被静默剔除）。
    expect(indexCode, '中国版不得误用国际站实例')
      .not.toMatch(/product: MINIMAX,[\s\S]{0,400}selector:\s*minimaxIntlBalanceSelector,/)
    expect(indexCode).toMatch(/lockedError:\s*minimaxLockedError\('MiniMax Code \(中国版\)',\s*'minimax'\)/)
    expect(indexCode).toMatch(/lockedError:\s*minimaxLockedError\('MiniMax Code \(国际版\)',\s*'minimaxintl'\)/)
    for (const [selector, display] of [
      ['minimaxBalanceSelector', "minimaxLockedError('MiniMax Code (中国版)', 'minimax')"],
      ['minimaxIntlBalanceSelector', "minimaxLockedError('MiniMax Code (国际版)', 'minimaxintl')"],
    ] as const) {
      const at = indexCode.indexOf(`selector: ${selector},`)
      expect(at, `找不到 selector: ${selector},`).toBeGreaterThan(-1)
      const candidates = [
        indexCode.indexOf('selector: minimaxBalanceSelector,', at + 1),
        indexCode.indexOf('selector: minimaxIntlBalanceSelector,', at + 1),
        indexCode.indexOf('\n  const ', at + 1),
        indexCode.indexOf('registerMinimaxLlm(', at + 1),
      ].filter((i) => i > at)
      let end = candidates.length > 0 ? Math.min(...candidates) : undefined
      // ⚠️ 收紧：若区间内出现 `throwIfAllRateLimited`，就把它所在的那个
      //    `balance` 块收尾（下一个同级 `},`）当作终点 —— 避免把下一站
      //    的 balance 块也圈进来（否则报错时点名的渠道会错位）。
      const withRate = indexCode.indexOf('throwIfAllRateLimited:', at)
      if (withRate !== -1 && (end === undefined || withRate < end)) {
        const close = indexCode.indexOf('\n      },', withRate)
        if (close !== -1 && (end === undefined || close < end)) end = close
      }
      const block = indexCode.slice(at, end)
      expect(block.length, `${selector} 的接线区间切成了空——判据会变成同义反复`).toBeGreaterThan(50)
      expect(block, `${selector} 的区间必须含 lockedError: ${display}`).toContain(`lockedError: ${display}`)
      expect(
        block,
        `${selector} 必须接 throwIfAllRateLimited（池被本模型限流时会误报「请先登录」）`,
      ).toMatch(/throwIfAllRateLimited:\s*throwIfAllAccountsRateLimited/)
    }
  })

  /**
   * ⚠️ 两站都必须 `reportPickedAccount: true`（账本归属不能因新增 balance 而丢）。
   *
   * ⚠️ 这是**真实踩点**：buddy 系那两处写的是 `false`（旧闭包的历史不对称），
   *    而 MiniMax 的旧闭包是**纯池选号**、账本**一直在回报**。照抄 `false` 会让
   *    「分档选中」那一支不再回报 ⇒ token 用量记不到这个渠道上（静默）。
   *
   * ⚠️⚠️ **原判据是「全局出现次数 >= 2」⇒ 无牙**（2026-10-21 审计实测）：
   *    全局有 **4 处** `reportPickedAccount: true`（qoder 两站 + minimax 两站），
   *    把国际站那处改成 `false` 后仍有 3 处 ⇒ `>= 2` 照样成立 ⇒ **全绿**。
   *    反向对照的 `block` 切片（`indexOf('product: MINIMAX', start) + 400`）
   *    也**不含 balance 块**（实测该区间既无 true 也无 false）⇒ 同样恒绿。
   *
   * ⇒ 改成逐站切片（与 `throwIfAllRateLimited` 那条同款）。
   */
  it('⚠️ 两站都必须 `reportPickedAccount: true`（逐站切片，不得只数全局次数）', () => {
    for (const [selector, display] of [
      ['minimaxBalanceSelector', "minimaxLockedError('MiniMax Code (中国版)', 'minimax')"],
      ['minimaxIntlBalanceSelector', "minimaxLockedError('MiniMax Code (国际版)', 'minimaxintl')"],
    ] as const) {
      const at = indexCode.indexOf(`selector: ${selector},`)
      expect(at, `找不到 selector: ${selector},`).toBeGreaterThan(-1)
      const candidates = [
        indexCode.indexOf('selector: minimaxBalanceSelector,', at + 1),
        indexCode.indexOf('selector: minimaxIntlBalanceSelector,', at + 1),
        indexCode.indexOf('\n  const ', at + 1),
        indexCode.indexOf('registerMinimaxLlm(', at + 1),
      ].filter((i) => i > at)
      let end = candidates.length > 0 ? Math.min(...candidates) : undefined
      // ⚠️ 收紧：若区间内出现 `throwIfAllRateLimited`，就把它所在的那个
      //    `balance` 块收尾（下一个同级 `},`）当作终点 —— 避免把下一站
      //    的 balance 块也圈进来（否则报错时点名的渠道会错位）。
      const withRate = indexCode.indexOf('throwIfAllRateLimited:', at)
      if (withRate !== -1 && (end === undefined || withRate < end)) {
        const close = indexCode.indexOf('\n      },', withRate)
        if (close !== -1 && (end === undefined || close < end)) end = close
      }
      const block = indexCode.slice(at, end)
      expect(block.length, `${selector} 的接线区间切成了空——判据会变成同义反复`).toBeGreaterThan(50)
      expect(block, `${selector} 所在的 balance 块必须 lockedError: ${display}`)
        .toContain(`lockedError: ${display}`)
      expect(block, `${selector} 必须 reportPickedAccount: true（否则账本归属丢失）`)
        .toMatch(/reportPickedAccount:\s*true,/)
      expect(block, `${selector} 不得写 reportPickedAccount: false`)
        .not.toMatch(/reportPickedAccount:\s*false/)
    }
  })

  it('★ 国际站选号器必须透传 XFF（不做 ⇒ 聚合候选被静默剔除）', () => {
    // `agent.minimax.io` 按出口 IP 把大陆来源 307 到中国站，而中国站不认国际站
    // token ⇒ 折算恒失败。`pool.minimaxXff()` **每次现读**，不固化成字符串。
    const start = indexCode.indexOf('const minimaxIntlBalanceSelector = new BuddyBalanceSelector({')
    expect(start, 'index.ts 里找不到国际站选号器').toBeGreaterThan(-1)
    const block = indexCode.slice(start, indexCode.indexOf('})', start))
    expect(block, '国际站选号器必须传 pool.minimaxXff()').toMatch(/pool\.minimaxXff\(\)/)
    // 中国版**不得**传 xff（它的主机本就在境内，多传一个头会被上游判签名不符）。
    const cnStart = indexCode.indexOf('const minimaxBalanceSelector = new BuddyBalanceSelector({')
    const cnBlock = indexCode.slice(cnStart, indexCode.indexOf('})', cnStart))
    expect(cnBlock, '中国版不得传 xff').not.toMatch(/minimaxXff/)
  })

  it('★ 锁定文案与 buddy 系分开（MiniMax 没有「资源包」这个概念）', () => {
    // buddy 系口径是「服务端资源包 N 天内到期」，MiniMax 是「每日签到 / 活动发放、
    // 每条明细自带 30 天有效期」—— 按 buddy 那句去排查会找不到那个「资源包」。
    expect(indexCode, 'minimax 必须有独立的 lockedError 文案构造器')
      .toContain('const minimaxLockedError =')
    const start = indexCode.indexOf('const minimaxLockedError =')
    const block = indexCode.slice(start, indexCode.indexOf('\n  }\n', start))
    // `credential-only` 档必须**明确劝阻解锁**（解锁不可撤回地烧永久积分，
    // 而该情形的根因在凭据、与积分无关）。
    expect(block, '必须处理 credential-only 档').toContain("reason.kind === 'credential-only'")
    expect(block, 'credential-only 文案必须劝阻解锁').toContain('不要去解锁永久积分')
    // 穷尽性守卫：兜底只允许 exhausted（否则将来加档位会静默落进「积分用尽」）。
    expect(block, '必须有穷尽性守卫（exhaustedOnly）').toContain('const exhaustedOnly: { kind: \'exhausted\' } = reason')
    // 错误码必须是宿主可分类的那种（QUOTA_EXCEEDED），不能是裸 Error。
    expect(block, '必须用 LlmError 而非裸 Error（裸 Error 没有 code）').toContain('new LlmError(')
    expect(block, '两站共用本函数，displayName 必须逐站区分').toContain('displayName')
  })

  /**
   * ★★ **`fetchBalance` 闭包内必须透传 `product` 形参**（2026-10-21 审计发现：零覆盖）。
   *
   * `BuddyBalanceSelector.select` 调的是 `injected(credential, this.deps.product)`
   * ⇒ 闭包里若忽略形参、写死站点常量，请求会打到**对方站点**：
   * ```
   * 正常          → 用 deps.product      ✓
   * 写死 MINIMAX  → 中国版常量           ✗ 打错站点 ⇒ 余额恒 null
   * ```
   * 后果：未锁定时换号优化失效、锁定时永远报「没有可用账号」（静默）。
   *
   * 审计实测：把中国版的闭包恒传 `MINIMAX_INTL`，本文件 **14 条全绿** —— 零覆盖。
   * ⇒ 按构造块切片断言（全局正则会命中别人家）。
   */
  it('★★ 两站的 fetchBalance 闭包必须透传 product 形参（不得写死对方站点）', () => {
    const cases = [
      ['minimaxBalanceSelector', 'MINIMAX_INTL'],
      ['minimaxIntlBalanceSelector', 'MINIMAX,'],
    ] as const
    for (const [name, other] of cases) {
      const start = indexCode.indexOf(`const ${name} = new BuddyBalanceSelector({`)
      expect(start, `找不到 ${name}`).toBeGreaterThan(-1)
      // ⚠️ 终点不能取 `\n  })`：minimax 的`fetchBalance` 闭包体里就有同样缩进的
      //    `})` 收尾（多行箭头函数），会提前截断 ⇒ 实测 `fetchBalance` 都取不到。
      //    改取下一个同级 `const` 声明。
      const end = indexCode.indexOf('\n  const ', start + 10)
      const block = indexCode.slice(start, end === -1 ? undefined : end)
      expect(block.length, `${name} 的构造块切成了空——判据会变成同义反复`).toBeGreaterThan(60)
      const lines = block.match(/fetchBalance:[\s\S]*?(?=\n\s*\}\)|$)/)
      expect(lines, `${name} 必须注入 fetchBalance`).not.toBeNull()
      // 形参必须叫 product 且被传给 fetchMinimaxCreditBalance。
      //
      // ⚠️ 2026-10-24（国际站账号代理）：`minimaxIntlBalanceSelector` 的闭包
      // **允许**带第三个形参 `ctx`（`BalanceFetchContext`：按账号取出口）——
      // 余额端点也在 `agent.minimax.io` 上，不给账号上下文则配了代理的账号
      // 恒查不到余额 ⇒ 在聚合轮换里被**静默剔除**（选号器知道账号 id，
      // 不传下去代理就没接上）。判据放宽为 `(credential, product[, …])`，
      // 但**「product 必须被透传」与「不得写死对方站点」两格不变**。
      expect(lines![0], `${name} 的 fetchBalance 必须含 (credential, product) =>`)
        .toMatch(/\(credential, product[,)]/)
      /**
       * ⚠️⚠️ **「product 被透传」必须锚在「调用点的实参」上**（PR !145 审计修法）。
       *
       * 初版写成 `expect(lines![0]).toMatch(/\bproduct\b/)` —— 而 `lines![0]`
       * 就是**形参行** `fetchBalance: (credential, product, ctx) =>`，
       * `\bproduct\b` **必然命中那个形参名** ⇒ 判据**恒真**，与实参无关。
       *
       * 实测「能通过但实际错误」的写法（全部全绿）：
       *
       *     fetchBalance: (credential, product, ctx) => {
       *       const station = MINIMAX          // 中国站常量！
       *       return fetchMinimaxCreditBalance(credential, ctx?.fetchFor?.(…) ?? fetch, station, …)
       *     }
       *
       * ⇒ 改为**两条腿**：
       * ① 调用点的第三实参必须**逐字是 `product`**（锚在 `fetchMinimaxCreditBalance(`
       *    之后到行尾的那一段，避开形参）；
       * ② `not.toContain(other)` 保留（写死对方站点常量会红）。
       *    但**别名绕不过 ①** —— 那正是初版被打穿的那一格。
       */
      const callStart = lines![0].indexOf('fetchMinimaxCreditBalance(')
      expect(callStart, `${name} 必须调用 fetchMinimaxCreditBalance`).toBeGreaterThan(-1)
      const callArgs = lines![0].slice(callStart)
      // 第三实参：`credential` / `fetcher` / `product` 三格里的最后一格。
      // 允许跨行（国际站版是多行），故在**整段** `lines![0]` 的调用区间里判。
      expect(
        callArgs,
        `${name} 的调用点必须把形参 product 作为**站点实参**透传`
        + `（写成别的常量/别名会打到错的站点，而用户看不到任何报错）`,
      ).toMatch(/,\s*product\s*[,)]/)
      expect(lines![0], `★ ${name} 的 fetchBalance 不得写死 ${other}（会打到对方站点）`)
        .not.toContain(other)
    }
  })
})

describe('★★ MiniMax：分档行为（驱动生产判据，不是复述实现）', () => {
  it('★ `expire_at_ms`（毫秒时间戳）被原样写成 `deductionEndTime`', async () => {
    const expires = Date.now() + 20 * 86400_000
    const fetcher = vi.fn().mockResolvedValue(json(detailsPayload([expires])))
    const balance = await fetchMinimaxCreditBalance(CRED, fetcher as never)
    const pkg = balance!.packages.find((p) => p.active)
    expect(pkg, '生产解析器没有产出 active 包').toBeDefined()
    // ⚠️ 关键：客户端 `splitCreditsByExpiry` 与聚合的 `sharedPackageExpiry`
    //    **只认 `deductionEndTime`**（`expiredTime` 字符串仅 tooltip 用）。
    expect(pkg!.deductionEndTime, '必须写毫秒时间戳（不是秒、不做 Date.parse）').toBe(expires)
    // 与 astudio 的形态差异：那不写入 0、也不做时区换算。
    expect(pkg!.expiredTime, '原始时刻应以 ISO 串透出（供 tooltip）')
      .toBe(new Date(expires).toISOString())
  })

  it('⚠️ 明细缺 `expire_at_ms` ⇒ 不写该键（不编造 0 / 不编造远期时刻）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({
      details: [{ remaining_amount: '400.00', granted_amount: '400.00' }],
      total_count: 1,
      base_resp: { status_code: 0 },
    }))
    const balance = await fetchMinimaxCreditBalance(CRED, fetcher as never)
    const pkg = balance!.packages.find((p) => p.active)
    // ⚠️ `undefined` = 「到期时间未知」（落永久桶）；填 0 会被判成「服务端未下发」，
    //    两者语义不同但都落永久桶 —— 编造一个远期时刻才是真错误（永远落不进永久桶）。
    expect(pkg!.deductionEndTime).toBeUndefined()
  })

  it('★ 锁定后只剩长期积分（30 天 > 15 天窗口）⇒ 该号不可用（tier = none）', async () => {
    const balance = await balanceExpiringIn(30)
    const now = Date.now()
    const windowMs = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const split = splitBuddyCreditsByExpiry(balance, now, windowMs)
    expect(split, '应能分桶').toBeDefined()
    // 30 天 > 15 天窗口 ⇒ 落永久桶（不是临期）。
    expect(split!.expiring, '30 天到期不该落临期桶').toBe(0)
    expect(split!.permanent).toBeGreaterThan(0)

    // ⚠️ `buddyBalanceTier` 吃的**不是** `CreditBalance`，而是分桶后的账号摘要
    //    `{ expiringBalance, permanentBalance }` —— 生产链是
    //    `BuddyBalanceSelector.classify()`。直接传 `balance` 会因字段名对不上
    //    而恒得 `none`（写 astudio 那份用例时实测踩到）。
    const entry = { id: 'a', expiringBalance: split!.expiring, permanentBalance: split!.permanent }
    // 未锁定：长期额度可用。
    expect(buddyBalanceTier(entry, { allowPermanent: true, windowMs }))
      .toBe(BUDDY_BALANCE_TIER.permanent)
    // ★ 锁定：只剩长期 ⇒ 明确不可用。这就是「锁定真的会拦」的那一步。
    expect(
      buddyBalanceTier(entry, { allowPermanent: false, windowMs }),
      '锁定后只剩永久积分 ⇒ 必须落 none（否则锁定形同虚设）',
    ).toBe(BUDDY_BALANCE_TIER.none)
    expect(buddyTierUsable(buddyBalanceTier(entry, { allowPermanent: false, windowMs }))).toBe(false)
  })

  it('★ 有临期积分时锁定仍可用（锁定只挡永久桶，不挡临期桶）', async () => {
    const balance = await balanceExpiringIn(10)
    const now = Date.now()
    const windowMs = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const split = splitBuddyCreditsByExpiry(balance, now, windowMs)
    expect(split!.expiring, '10 天到期应落临期桶').toBeGreaterThan(0)
    const entry = { id: 'a', expiringBalance: split!.expiring, permanentBalance: split!.permanent }
    expect(buddyBalanceTier(entry, { allowPermanent: false, windowMs }))
      .toBe(BUDDY_BALANCE_TIER.expiring)
    expect(buddyTierUsable(buddyBalanceTier(entry, { allowPermanent: false, windowMs }))).toBe(true)
  })

  it('★ 混合桶（一临期 + 一长期）锁定后仍可用（临期桶非空即放行）', async () => {
    const now = Date.now()
    const fetcher = vi.fn().mockResolvedValue(
      json(detailsPayload([now + 5 * 86400_000, now + 60 * 86400_000])),
    )
    const balance = await fetchMinimaxCreditBalance(CRED, fetcher as never)
    const windowMs = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const split = splitBuddyCreditsByExpiry(balance!, now, windowMs)
    const entry = { id: 'a', expiringBalance: split!.expiring, permanentBalance: split!.permanent }
    // 5 天 ⇒ 临期；60 天 ⇒ 永久。锁定只挡永久桶 ⇒ 仍可用。
    expect(split!.expiring).toBeGreaterThan(0)
    expect(split!.permanent).toBeGreaterThan(0)
    expect(buddyBalanceTier(entry, { allowPermanent: false, windowMs }))
      .toBe(BUDDY_BALANCE_TIER.expiring)
  })

  it('★ 窗口天数与前端/后端同源（15 天）', () => {
    // 数字写岔会让用户看到「提示说只烧 8 天内的，实际按 15 天筛号」。
    // 两站的选号器与 buddy 系共用 `BuddyBalanceSelector`，故窗口也共用一份判据
    //（`buddy-balance-rank.ts` 是唯一真源）。
    expect(BUDDY_EXPIRING_WINDOW_DAYS).toBe(15)
  })

  it('端点常量指向两家自己的主机（不是 buddy 系、两站也不同）', () => {
    // ⚠️ `BuddyBalanceSelector` 的 `fetchSource` 里有一条防御：
    //    「非 buddy 系必须注入 `fetchBalance`」（否则会用 product.endpoint 拼出
    //    错误的余额 URL）。本家已注入，故这条只钉住 product 常量本身。
    expect(MINIMAX.apiHost).toContain('minimax.cn')
    expect(MINIMAX_INTL.apiHost).toContain('minimax.io')
    expect(MINIMAX.apiHost).not.toBe(MINIMAX_INTL.apiHost)
  })
})
