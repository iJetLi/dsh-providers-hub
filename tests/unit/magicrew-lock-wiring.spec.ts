/**
 * Magicrew（国内站 `magicrew` = 超级麦吉 / 国际站 `magicrewintl` = MagiCrew (国际版)）
 * 的「**三档积分** + **锁定永久积分**」接线回归。
 *
 * ## 为什么单独守这个
 *
 * 2026-11-01 用户要求「给超级麦吉 / MagiCrew (国际版) 的积分加永久/长期/临期
 * 和锁定/解锁永久积分功能」。此前本家 `provider-registry.ts` 里**刻意**不登记
 * `usesExpiryWindow` / `permanentLock`，理由注释写的是「本家没有这两个能力」。
 *
 * ⚠️ 那两条理由**已被真实报文推翻**（见下），所以本文件守的是这次补齐：
 * 登记 `usesExpiryWindow` 才会回传 `windowDays`（缺了前端三档行**整行不渲染**，
 * 零报错），登记 `permanentLock` 才会有按钮 + RPC 放行。
 *
 * ## 本家的三个特异点（照抄别家会错）
 *
 * 1. **永久积分不是上游的一个字段，而是一次减法**：
 *    `total_points − Σ(expiring_quota_details[].remaining_points)` 的**残差**。
 *    `src/magicrew-credits.ts` 把它**合成**一条 `name: '永久积分'` 的包。
 *    ⚠️ 合成包**刻意不带** `deductionEndTime` —— 那是它落进 `permanent` 桶的唯一依据；
 *    编一个远期值会让它落进 `longTerm`（黄）并且让锁定永久积分**保护不到**它。
 * 2. **`expiring_quota_details` 不是「只含临期」**（旧注释的说法已作废）：真实账号里
 *    它同时含今天到期的批次与 2027 年到期的远期批次 ⇒ 「长期」（黄）就是这个批次
 *    集合里**超出窗口**的那部分，不需要额外字段。
 * 3. **`rateLimit: false` + 不做请求级换号**：锁定只作用于「按余额分档选号」这一层。
 *    ⚠️ 因此**不能**照抄 buddy 系关于换号冷却的取舍。
 *
 * ## 判据分三层（由弱到强）
 *
 * 1. **registry 契约**：两站 `permanentLock === true` 且 `usesExpiryWindow === true`，
 *    且后端白名单确实由 registry **派生**（有人手抄一份名单会在这里红）。
 * 2. **源码接线**：`src/index.ts` 里确实建了**两个**选号器、各自接到工厂的
 *    `balance.selector`、各自传了带**本站 `displayName`** 的 `lockedError`、
 *    且 `fetchBalance` 闭包**透传 `product` 形参**（写死站点 = 打到对方站点）。
 *    ⚠️ 每条都按**该站的接线区间**切片，不用全局正则 —— 全局正则会命中别人家，
 *    本仓库已实测两次无牙。
 * 3. **分档行为**：把**真实账号报文**（2026-11-01 只读探测的两站实际合计）
 *    喂给生产解析器 `fetchMagicrewBalance`，再分别用前端的
 *    `splitCreditsByExpiry`（三档展示口径）与后端的 `splitBuddyCreditsByExpiry` /
 *    `buddyBalanceTier`（两桶选号口径）验证分档与「锁定真的会拦」。
 *    这一层驱动生产判据，不是复述实现。
 *
 * ⚠️ **不做**的事：不发真实网络（`fetchImpl` 全部注入假实现）、不读真实凭据。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'
import { fetchMagicrewBalance } from '../../src/magicrew-credits.js'
import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import {
  BUDDY_BALANCE_TIER,
  BUDDY_EXPIRING_WINDOW_DAYS,
  buddyBalanceTier,
  buddyTierUsable,
  splitBuddyCreditsByExpiry,
} from '../../src/buddy-balance-rank.js'
// 展示口径的**生产实现**（前端与后端各自一份，判据必须逐条一致）。
import { splitCreditsByExpiry } from '../../plugin-src/client/credit-expiry.js'
import { MAGICREW, MAGICREW_INTL, type MagicrewProduct } from '../../src/magicrew-product.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 接线断言不能因为「注释里提到了某个符号」就通过：本仓库注释大量解释
 * 「为什么不能走某条兜底」，对兜底的**否定**断言必须只看代码
 * （与 `autoclaw-lock-wiring.spec.ts` 的 `codeOnly` 同一约定）。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
const indexCode = codeOnly(indexSource)

/**
 * 取某个选号器的接线区间（`selector: <name>,` 起，到**本块自己的闭合符号**为止）。
 *
 * ⚠️ **必须切片**：`src/index.ts` 里 `throwIfAllRateLimited` 有 18 处、
 * `isFreeModel: NO_FREE_MODEL` 有 9 处 ⇒ 全局正则恒真（本仓库实测过两次）。
 * ⚠️ **不能取裸 `'},'`、也不能取「下一个同级声明」**：两者都是**位置型**锚点 ——
 * 前者在块内出现嵌套对象时提前截断，后者对缩进敏感（二审实测打穿）。终点取
 * `'\n      },'`（本块自己的闭合）并配下面的结构性计数判据。
 */
function selectorBlock(name: string): string {
  const at = indexCode.indexOf(`selector: ${name},`)
  expect(at, `找不到 selector: ${name},`).toBeGreaterThan(-1)
  /**
   * ⚠️⚠️ **终点必须是「本块自己的闭合符号」，不是「下一个同级声明」**
   * （2026-11-01 二审实测打穿上一版）：上一版终点用 `\n  const ` —— 那是**缩进敏感**的，
   * 把下一个声明的缩进从 2 空格改成 4 空格，`indexOf` 就跳过它 ⇒ 切片从 6 行膨胀到
   * **21 行**（吞掉 15 行有效代码），而当时加的 `toBeLessThan(30)` 因为阈值标定在
   * 6 行上、目标变异只涨到 21 行 ⇒ **19/19 全绿**（无牙）。
   *
   * `balance: {` 的闭合在本文件里恒为 6 空格缩进的 `},`，且块内没有嵌套对象
   * ⇒ 从 `at` 起第一个 `\n      },` 就是本块的闭合，与「别的声明怎么缩进」无关。
   */
  const end = indexCode.indexOf('\n      },', at + 1)
  const block = indexCode.slice(at, end > at ? end : undefined)
  expect(end, `${name} 的切点解析失败（找不到 balance 块的闭合 \n      },）`).toBeGreaterThan(at)
  // 结构性不变量：切片吞进别的块时，这些**计数**会先变，而不是靠行数阈值去猜。
  expect(block.match(/lockedError:/g) ?? [], `${name} 的切片吞进了别家的 lockedError`)
    .toHaveLength(1)
  expect(block.match(/isFreeModel\s*:/g) ?? [], `${name} 的切片吞进了别家的 isFreeModel`)
    .toHaveLength(1)
  expect(block.split('\n').length, `${name} 的接线区间异常（实测 3 行）`).toBeLessThanOrEqual(10)
  expect(block.length, `${name} 的接线区间切成了空——判据会变成同义反复`).toBeGreaterThan(50)
  return block
}


/** 取 `const <name> = new BuddyBalanceSelector…` 到下一个同级 `const` 为止的构造区间。 */
function ctorBlock(name: string): string {
  const at = indexCode.indexOf(`const ${name} = new BuddyBalanceSelector`)
  expect(at, `找不到 const ${name} = new BuddyBalanceSelector`).toBeGreaterThan(-1)
  // ⚠️ 同 `selectorBlock`：终点用**本块自己的闭合**（`})` 在 2 空格缩进处），
  //    不用缩进敏感的 `\n  const `（那个终点已被二审实测打穿）。
  const end = indexCode.indexOf('\n  })', at + 10)
  const block = indexCode.slice(at, end > at ? end : undefined)
  expect(end, `${name} 的构造区间终点解析失败（找不到 \n  })`).toBeGreaterThan(at)
  // 结构性不变量：一个选号器只能有 1 个 product / 1 个 fetchBalance。
  expect(block.match(/\bproduct\s*:/g) ?? [], `${name} 的构造区间吞进了别家的 product`)
    .toHaveLength(1)
  expect(block.match(/\bfetchBalance\s*:/g) ?? [], `${name} 的构造区间吞进了别家的 fetchBalance`)
    .toHaveLength(1)
  expect(block.split('\n').length, `${name} 的构造区间异常（实测 8 行）`).toBeLessThanOrEqual(14)
  expect(block.length, `${name} 的构造区间切成了空`).toBeGreaterThan(80)
  return block
}

/**
 * 真实 `GET /api/v1/quota/points/total` 的响应（2026-11-01 两站**只读**探测）。
 *
 * ⚠️ 这两份 fixture 的**条数、合计、残差与关键到期边界**都是探测到的真值：
 *
 * | 站 | `total_points` | 批次数 | 批次合计 | 残差（永久） |
 * |---|---|---|---|---|
 * | 国内 | 2661 | 11 | 1661 | **1000** |
 * | 国际 | 347 | 2 | 247 | **100** |
 *
 * 单条批次的到期时刻取探测到的区间值（`2026-11-26 14:58:29` ~ `15:02:54` **七条**
 * —— `quota_id` 2~8，合计 11+50×6；`quota_id` 1 是当天到期、9~11 是一年后到期）；
 * 关键是**三类边界都得在**：当天到期（红）、一年后到期（黄）、无到期时间（绿）。
 */
function cnPointsResponse() {
  const at = (hm: string) => `2026-11-26 ${hm}`
  return {
    code: 1000,
    data: {
      total_points: 2661,
      expiring_quota_details: [
        { quota_id: 1, expires_at: '2026-11-01 23:59:59', remaining_points: 200 },
        { quota_id: 2, expires_at: at('14:58:29'), remaining_points: 11 },
        { quota_id: 3, expires_at: at('14:58:30'), remaining_points: 50 },
        { quota_id: 4, expires_at: at('14:59:01'), remaining_points: 50 },
        { quota_id: 5, expires_at: at('15:00:11'), remaining_points: 50 },
        { quota_id: 6, expires_at: at('15:01:02'), remaining_points: 50 },
        { quota_id: 7, expires_at: at('15:02:30'), remaining_points: 50 },
        { quota_id: 8, expires_at: at('15:02:54'), remaining_points: 50 },
        { quota_id: 9, expires_at: '2027-11-03 23:02:08', remaining_points: 100 },
        { quota_id: 10, expires_at: '2027-11-03 23:02:09', remaining_points: 50 },
        { quota_id: 11, expires_at: '2027-11-03 23:02:10', remaining_points: 1000 },
      ],
    },
  }
}

function intlPointsResponse() {
  return {
    code: 1000,
    data: {
      total_points: 347,
      expiring_quota_details: [
        { quota_id: 1, expires_at: '2026-11-01 23:59:59', remaining_points: 47 },
        { quota_id: 2, expires_at: '2027-11-03 23:45:12', remaining_points: 200 },
      ],
    },
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 解析用的固定时钟：2026-11-01 00:00（+08:00）= `2026-10-31T16:00:00Z`。 */
const NOW = Date.parse('2026-10-31T16:00:00.000Z')
/**
 * ⚠️ 窗口天数**必须取生产常量**，不能写死 15（2026-11-01 三审）：
 * 写死的话，有人把 `BUDDY_EXPIRING_WINDOW_DAYS` 改成别的值（或改判据的边界方向），
 * 本文件仍全绿 —— 它验的「16 天落永久 / 10 天落临期」会与实际窗口脱钩，
 * 只能靠 `tests/unit/buddy-balance-rank.spec.ts` 兜住（若那次也漏改就是集体假绿）。
 */
const WINDOW_DAYS = BUDDY_EXPIRING_WINDOW_DAYS
const WINDOW_MS = WINDOW_DAYS * 86400_000

// ⚠️ `buddyBalanceTier` 里**不读** `windowMs`（2026-11-01 四审登记，见 `BuddyTierOptions` 注释）：
//    下面几处传它只是保持调用形态与生产一致，**不承重**——把 4 处全改成 `windowMs: 1` 实测 20/20 仍绿。
//    真正钉窗口边界的是「不同到期时刻的真实报文」那几条（16 天落永久 / 10 天落临期）。

async function balanceOf(body: unknown, product = MAGICREW) {
  const balance = await fetchMagicrewBalance({
    jwt: 'j.w.t',
    organizationCode: 'org',
    product,
    fetchImpl: (async () => jsonResponse(body)) as unknown as typeof fetch,
  })
  expect(balance, '生产解析器应产出余额').toBeDefined()
  return balance!
}

describe('★ Magicrew：`permanentLock` / `usesExpiryWindow` 的 registry 契约', () => {
  it('两站都登记了 permanentLock 与 usesExpiryWindow', () => {
    for (const id of ['magicrew', 'magicrewintl']) {
      // 缺 `permanentLock` ⇒ 客户端 `supportsPermanentLock()` 为 false ⇒ 按钮**不渲染**，
      // 且 `credits.permanentLock` RPC 直接 `bad-request`。
      expect(descriptorOf(id)?.permanentLock, `${id} 应支持锁定永久积分`).toBe(true)
      // 缺 `usesExpiryWindow` ⇒ `credits.balances` / `credits.permanentLock` 都**不回传**
      // `windowDays` ⇒ 前端 `normalizeWindowDays()` 返回 null ⇒ 三档行**整行不渲染**
      //（积分本身照常显示，所以是「静默少了一行」，最难发现的一种）。
      expect(descriptorOf(id)?.usesExpiryWindow, `${id} 应回传窗口天数（否则三档行整行消失）`)
        .toBe(true)
    }
  })

  it('后端白名单（PERMANENT_LOCK_PROVIDERS）由 registry 派生且含两站', () => {
    // 直接钉住「派生关系」，而不是只断言成员 —— 有人手抄一份名单会在这里红。
    const derived = PROVIDER_REGISTRY.filter((d) => d.permanentLock === true).map((d) => d.id).sort()
    expect(derived).toContain('magicrew')
    expect(derived).toContain('magicrewintl')
    expect([...PERMANENT_LOCK_PROVIDERS].sort()).toEqual(derived)
  })

  it('⚠️ 两站是**两个**渠道 id（共用实现不等于共用一个 id）', () => {
    expect(MAGICREW.id).toBe('magicrew')
    expect(MAGICREW_INTL.id).toBe('magicrewintl')
    expect(MAGICREW.id).not.toBe(MAGICREW_INTL.id)
    // 锁定表是**按 provider id** 存的 ⇒ 两站各有一张，面板也各有一个开关。
    // ⚠️ 基址不同是本文件第 3 层「不得串号」判据的前提。
    expect(MAGICREW.host).not.toBe(MAGICREW_INTL.host)
  })
})

describe('★ Magicrew：`index.ts` 的接线（源码级，按站切片）', () => {
  it('两站各建一个选号器，且各自接到工厂的 balance.selector', () => {
    expect(indexCode).toMatch(
      /const magicrewBalanceSelector = new BuddyBalanceSelector<MagicrewProduct, MagicrewCredential>\(\{\n\s*product: MAGICREW,/,
    )
    expect(indexCode).toMatch(
      /const magicrewIntlBalanceSelector = new BuddyBalanceSelector<MagicrewProduct, MagicrewCredential>\(\{\n\s*product: MAGICREW_INTL,/,
    )
    // 建了不用 = 死代码，锁定仍无执行路径。
    expect(
      selectorBlock('magicrewBalanceSelector'),
      '国内版的 balance.selector 必须指向 magicrewBalanceSelector',
    ).toContain("lockedError: magicrewLockedError('超级麦吉'),")
    expect(
      selectorBlock('magicrewIntlBalanceSelector'),
      '国际版的 balance.selector 必须指向 magicrewIntlBalanceSelector',
    ).toContain("lockedError: magicrewLockedError('MagiCrew (国际版)'),")
  })

  it('★★ 两个 `balance` 段都必须带 `isFreeModel: NO_FREE_MODEL`（不得省略）', () => {
    // ⚠️ `createCredentialResolver` 的 `isFreeModel` 是**必填**字段，本家没有可注入的
    //    「modelId → 是否免费」查询点（免费判定在适配器内 `magicrewIsFree(wirePoints)`）
    //    ⇒ 用 `NO_FREE_MODEL` 显式表态「不知道」，而不是猜一个恒 false 的判据
    //    —— 猜错会让免费模型静默绕开锁定、真烧掉永久积分。
    for (const name of ['magicrewBalanceSelector', 'magicrewIntlBalanceSelector']) {
      expect(selectorBlock(name), `${name} 的 balance 段必须带 isFreeModel: NO_FREE_MODEL`)
        .toContain('isFreeModel: NO_FREE_MODEL,')
    }
  })

  it('★★ 两站的 fetchBalance 闭包必须透传 product 形参（不得写死对方站点）', () => {
    // `BuddyBalanceSelector.select` 调的是 `injected(credential, this.deps.product)`
    // ⇒ 闭包里忽略形参、写死站点常量就会打到**对方站点**（余额恒读不到，
    //   而症状是「锁定时永远报『无法确认』」，与 `provider-expiry.ts` 那次
    //   漏传 `product` 完全同型）。
    const cases = [
      ['magicrewBalanceSelector', 'MAGICREW_INTL'],
      ['magicrewIntlBalanceSelector', 'MAGICREW,'],
    ] as const
    for (const [name, other] of cases) {
      const ctor = ctorBlock(name)
      expect(ctor, `${name} 必须注入 fetchBalance`).toContain('fetchBalance:')
      expect(
        ctor,
        `${name} 必须把 product 形参传给 fetchMagicrewBalance`,
      ).toMatch(/fetchBalance: async \(credential, product\) => await fetchMagicrewBalance\(\{/)
      expect(ctor, `${name} 的 fetchBalance 必须把 product 传下去`).toContain('product,')
      expect(
        ctor,
        `★ ${name} 的 fetchBalance 不得写死 ${other}（会打到对方站点，余额恒读不到）`,
      ).not.toContain(other)
      // `fetchMagicrewBalance` 用 `undefined` 表达「读不到」，而选号器契约是 `null`
      //（`undefined` 会被当成「没实现」）⇒ 这个 `?? null` 是承重件。
      expect(ctor, `${name} 必须用 ?? null 归一契约差异`).toContain('?? null')
    }
  })

  it('★ `magicrewLockedError` 的四档都用 `QUOTA_EXCEEDED`（不得落成 AUTH / TRANSPORT）', () => {
    const at = indexCode.indexOf('const magicrewLockedError')
    expect(at, '找不到 magicrewLockedError').toBeGreaterThan(-1)
    const end = indexCode.indexOf('\n  const ', at + 10)
    const block = indexCode.slice(at, end > at ? end : undefined)
    // 四档：unknown / no-candidates / credential-only / exhausted。
    expect(block.match(/'QUOTA_EXCEEDED'/g) ?? [], '四档都必须是 QUOTA_EXCEEDED')
      .toHaveLength(4)
    // ⚠️ `AUTH` 会把 message 一起吞掉（本仓库复发形态），而这里的 message
    //    **本身就是出路**（「去哪个面板解锁 / 别去解锁」）⇒ 绝不能用它。
    expect(block, '不得用 AUTH（会吞掉唯一指路文案）').not.toContain("'AUTH'")
    // ⚠️ `TRANSPORT` 是可重试码，而「锁定 + 只剩永久积分」重试一万次也不会好
    //    （Loomy 那家才是 TRANSPORT，见 `loomy-balance-error-contract.spec.ts`）。
    expect(block, '不得用可重试的 TRANSPORT').not.toContain("'TRANSPORT'")
    // 四档必须穷尽 `BuddyNoAccountReason`：漏一档会让该情形落到 `undefined`
    // 分支（`throw undefined` ⇒ 用户看到的是「Unknown error」）。
    expect(block, '必须含穷尽性守卫').toContain('const exhaustedOnly: { kind: \'exhausted\' } = reason')
  })

  it('★★ `no-candidates` 档不得提「被模型限流」—— 本家从不写 modelRateLimits，这一成因不存在', () => {
    // 二审（2026-11-01）挖出的真问题：四档文案是从 buddy 系抄来的，而 buddy 的
    // `no-candidates` 可以是「全部账号被**本次请求的模型**限流」（`src/credential-resolver.ts`
    // 的 `candidatesOf()` 会按 `modelRateLimits[modelId]` 把它们筛掉）。
    // 本家的适配器**从不写** `modelRateLimits`（`src/magicrew-adapter.ts` 等三个文件里
    // `updateModelRateLimit()` 调用 0 处）⇒ 那个条件恒放行 ⇒ 本档只可能是
    // 「没有启用中的账号」。
    //
    // ⚠️ **理由不是** `rateLimit: false`：国内站省略该字段（= true）、只有国际站写了
    //    `false`，且该字段只管辖「重测 / 重置」按钮、不驱动写入。
    // 写进文案就是让用户排查一个**不可能存在**的方向（IKLBSH 那条纪律）。
    const at = indexCode.indexOf('const magicrewLockedError')
    const end = indexCode.indexOf('\n  const ', at + 10)
    const whole = indexCode.slice(at, end > at ? end : undefined)
    const segStart = whole.indexOf("if (reason.kind === 'no-candidates') {")
    expect(segStart, '找不到 no-candidates 分支').toBeGreaterThan(-1)
    const segEnd = whole.indexOf("if (reason.kind === 'credential-only') {", segStart)
    expect(segEnd, '找不到下一个分支（切片终点失效会退化成同义反复）').toBeGreaterThan(segStart)
    const seg = whole.slice(segStart, segEnd)
    expect(seg.split('\n').length, 'no-candidates 分支区间膨胀了').toBeLessThan(40)
    // 反证：不得出现指向不存在成因的字样（注释里允许解释「为什么不存在」，
    // 故这里对**剥注释后的代码**断言，避免把解释性注释本身判成违规）。
    const code = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code, '本家不写 modelRateLimits，文案里不得提它').not.toContain('模型上受限')
    expect(code, '同上').not.toContain('限流')
    // 正向：必须指向真实出路（账号启用状态）。
    expect(code, '必须指向真出路：账号是否启用').toContain('启用中')
  })
  it('⚠️ `magicrewLockedError` 的位置：必须在本家自己的锁定错误区间，不得插进 Loomy 的切片', () => {
    // ⚠️ 这里原先写的是「插进 Loomy 区间会让 loomy-balance-error-contract.spec.ts
    // 必然变红」—— **那是错的**（2026-11-01 二审实测）：该 spec 的终点锚点早在
    // 2026-10-20 就从 `const buddy = new BuddyAuth` 换成了 `'\n  const '`（下一个
    // 同级声明），实测插一个同级的 `QUOTA_EXCEEDED` const 后那个切片逐字节不变。
    // 位置的真实守卫**就是本条自己**（`mine < loomy`），别再引一个不存在的旁证。
    const mine = indexCode.indexOf('const magicrewLockedError')
    const loomy = indexCode.indexOf('const loomyLockedError')
    const buddy = indexCode.indexOf('const buddy = new BuddyAuth')
    expect(mine).toBeGreaterThan(-1)
    expect(loomy).toBeGreaterThan(-1)
    expect(buddy).toBeGreaterThan(-1)
    expect(mine, '本家的锁定错误必须排在 `const loomyLockedError` 之前').toBeLessThan(loomy)
  })
})

describe('★★ Magicrew：三档分档（真实报文驱动生产解析器）', () => {
  it('★ 国内站真实报文 ⇒ 永久 1000 / 长期 1461 / 临期 200（合计 2661）', async () => {
    const balance = await balanceOf(cnPointsResponse())
    expect(balance.total, 'total_points 原样透传').toBe(2661)
    // 守恒：合成包存在的**唯一**理由是让 hover 列包合计对得上 total_points。
    expect(balance.packages.reduce((s, p) => s + p.remaining, 0), 'sum(remaining) === total')
      .toBe(2661)
    // 11 条批次 + 1 条合成包。
    expect(balance.packages).toHaveLength(12)

    const split = splitCreditsByExpiry(balance.packages, WINDOW_DAYS, NOW)
    expect(split, '窗口可用时应返回三档（返回 null = 整行不渲染）').not.toBeNull()
    expect(split!.expiring, '当天到期的那 200 分落临期（红）').toBe(200)
    expect(
      split!.longTerm,
      '到期时间超出窗口的批次落长期（黄）—— 这就是用户口径里的「长期积分」，'
      + '**不是**那条合成包',
    ).toBe(1461)
    expect(
      split!.permanent,
      '上游不下发到期时间的那部分落永久（绿）= total − Σ批次',
    ).toBe(1000)
    // 三档必须**恰好覆盖**全部积分（漏一分就是显示 bug）。
    expect(split!.expiring + split!.longTerm + split!.permanent).toBe(2661)
  })

  it('★ 国际站真实报文 ⇒ 永久 100 / 长期 200 / 临期 47（合计 347）', async () => {
    const balance = await balanceOf(intlPointsResponse(), MAGICREW_INTL)
    expect(balance.total).toBe(347)
    expect(balance.packages).toHaveLength(3)
    const split = splitCreditsByExpiry(balance.packages, WINDOW_DAYS, NOW)!
    expect(split.expiring).toBe(47)
    expect(split.longTerm).toBe(200)
    expect(split.permanent).toBe(100)
    expect(split.expiring + split.longTerm + split.permanent).toBe(347)
  })

  it('★★ 合成包**必须没有** `deductionEndTime`（编一个远期值会毁掉锁定）', async () => {
    for (const [body, expected, product] of [
      [cnPointsResponse(), 1000, MAGICREW],
      [intlPointsResponse(), 100, MAGICREW_INTL],
    ] as const) {
      const balance = await balanceOf(body, product)
      const permanent = balance.packages.find((p) => p.deductionEndTime === undefined)
      expect(permanent, '必须恰好有一条无到期时间的合成包').toBeDefined()
      expect(permanent!.name, '合成包的名字必须叫「永久积分」而不是「长期积分」').toBe('永久积分')
      expect(permanent!.remaining).toBe(expected)
      // ⚠️ 反向：除它之外**不得**再有包缺 `deductionEndTime`（那说明批次解析丢了到期时间，
      //    会把长期批次静默算进永久桶 ⇒ 锁定后误判可用）。
      expect(balance.packages.filter((p) => p.deductionEndTime === undefined)).toHaveLength(1)
    }
  })

  it('★ 批次里**确实有超出窗口的远期批次**（旧注释「只下发临期」已作废）', async () => {
    const balance = await balanceOf(cnPointsResponse())
    const farFuture = balance.packages.filter(
      (p) => p.deductionEndTime !== undefined && p.deductionEndTime > NOW + 300 * 86400_000,
    )
    // 2027-11-03 那三条（100 / 50 / 1000）。
    expect(farFuture, '真实批次里含一年后到期的批次 ⇒ 不能按「只有临期」过滤').toHaveLength(3)
    expect(farFuture.reduce((s, p) => s + p.remaining, 0)).toBe(1150)
  })

  it('⚠️ 反证：`total_points` 与批次和相等时**不**合成永久包（残差 ≤ 0 不造包）', async () => {
    const balance = await balanceOf({
      code: 1000,
      data: {
        total_points: 100,
        // 批次和 = 100 ⇒ 残差 0 ⇒ 不能凭空造一条「永久积分 0」。
        expiring_quota_details: [
          { quota_id: 1, expires_at: '2026-11-10 12:00:00', remaining_points: 100 },
        ],
      },
    })
    expect(balance.packages).toHaveLength(1)
    expect(balance.packages.some((p) => p.name === '永久积分')).toBe(false)
  })
})

describe('★★ Magicrew：锁定真的会拦（驱动选号判据）', () => {
  /** 把真实余额折成选号判据要的那两个量（后端只分两桶，longTerm 并入 permanent）。 */
  async function tierEntry(body: unknown, product = MAGICREW) {
    const balance = await balanceOf(body, product)
    const split = splitBuddyCreditsByExpiry(balance, NOW, WINDOW_MS)
    expect(split, '后端两桶应能算出').toBeDefined()
    return { id: 'a', expiringBalance: split!.expiring, permanentBalance: split!.permanent }
  }

  it('★ 后端两桶：longTerm 与「无到期时间」合并进 permanent（选号口径的唯一依据）', async () => {
    const entry = await tierEntry(cnPointsResponse())
    expect(entry.expiringBalance, '窗口内 = 200').toBe(200)
    // 1461（长期）+ 1000（永久）= 2461。
    expect(entry.permanentBalance, '长期与永久在后端合并成一桶').toBe(2461)
    // 未锁定时该号可用，且档位是 permanent（expiring === 0 时才有意义；此处 > 0）。
    expect(buddyBalanceTier(entry, { allowPermanent: true, windowMs: WINDOW_MS }))
      .toBe(BUDDY_BALANCE_TIER.expiring)
  })

  it('★★ 锁定后「只剩永久/长期」⇒ 该账号不可用（锁定不是形同虚设）', async () => {
    // 构造一个**只有**永久 + 长期、没有窗口内批次的号：真实场景就是「签到额度烧光了，
    // 只剩活动赠送与一年后到期的那部分」。这正是锁定存在的理由。
    const balance = await balanceOf({
      code: 1000,
      data: {
        total_points: 1500,
        expiring_quota_details: [
          { quota_id: 1, expires_at: '2027-11-03 23:02:08', remaining_points: 500 },
        ],
      },
    })
    const split = splitBuddyCreditsByExpiry(balance, NOW, WINDOW_MS)!
    const entry = { id: 'a', expiringBalance: split.expiring, permanentBalance: split.permanent }
    expect(entry.expiringBalance, '这批没有窗口内批次').toBe(0)
    expect(entry.permanentBalance, '500 长期 + 1000 永久').toBe(1500)

    // 未锁定：可以用（虽然要烧永久积分）。
    expect(buddyBalanceTier(entry, { allowPermanent: true, windowMs: WINDOW_MS }))
      .toBe(BUDDY_BALANCE_TIER.permanent)
    // ★ 锁定：明确不可用 —— 这就是「锁定真的会拦」的那一步。
    expect(
      buddyBalanceTier(entry, { allowPermanent: false, windowMs: WINDOW_MS }),
      '锁定后只剩永久/长期积分 ⇒ 必须落 none（否则锁定形同虚设）',
    ).toBe(BUDDY_BALANCE_TIER.none)
    expect(buddyTierUsable(buddyBalanceTier(entry, { allowPermanent: false, windowMs: WINDOW_MS })))
      .toBe(false)
  })

  it('★ 有临期批次时锁定仍可用（锁定只挡永久桶，不挡临期桶）', async () => {
    const entry = await tierEntry(cnPointsResponse())
    expect(entry.expiringBalance).toBeGreaterThan(0)
    expect(
      buddyBalanceTier(entry, { allowPermanent: false, windowMs: WINDOW_MS }),
      '有窗口内积分 ⇒ 锁定不影响该号',
    ).toBe(BUDDY_BALANCE_TIER.expiring)
    expect(buddyTierUsable(buddyBalanceTier(entry, { allowPermanent: false, windowMs: WINDOW_MS })))
      .toBe(true)
  })

  it('⚠️ 窗口边界：16 天后到期落「永久桶」（后端两桶口径），10 天后落临期桶', async () => {
    // 后端 `splitBuddyCreditsByExpiry` 只分两桶 ⇒ 「长期」在选号时与永久同权。
    // 这条把边界钉在 15 天，防止有人把窗口改成「30 天」而不改文案/倒计时。
    const atDays = (days: number) => {
      const ms = NOW + days * 86400_000
      // 上游给的是 UTC+8 的本地串 ⇒ 反过来拼出来（避免时区换算写错）。
      const shifted = new Date(ms + 8 * 3600_000)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
        + ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
    }
    const balance = await balanceOf({
      code: 1000,
      data: {
        total_points: 300,
        expiring_quota_details: [
          { quota_id: 1, expires_at: atDays(16), remaining_points: 100 },
          { quota_id: 2, expires_at: atDays(10), remaining_points: 200 },
        ],
      },
    })
    const split = splitBuddyCreditsByExpiry(balance, NOW, WINDOW_MS)!
    expect(split.expiring, '10 天后到期 = 窗口内').toBe(200)
    expect(split.permanent, '16 天后到期 = 超出窗口 ⇒ 后端并入永久桶').toBe(100)
    // 前端三档会把它标成「长期」（黄），而不是「永久」（绿）—— 两套口径**刻意**不同：
    // 展示要能分辨「一年后到期」与「永不作废」，选号只需要「会不会马上作废」。
    const ui = splitCreditsByExpiry(balance.packages, WINDOW_DAYS, NOW)!
    expect(ui.expiring).toBe(200)
    expect(ui.longTerm, '前端把超窗口的批次标成长期').toBe(100)
    expect(ui.permanent, '没有无到期时间的包 ⇒ 永久档为 0').toBe(0)
  })
})

describe('⚠️ Magicrew：两站选号器是**不同实例**（共用会串号）', () => {
  it('`BuddyBalanceSelector` 的 product 决定它查哪个站点的余额', () => {
    // 结构性判据：两个 selector 各自以不同的 product 构造。
    // ⚠️ 共用实例的后果是**单向**的（一个站永远查不到余额，另一个正常），
    //    所以这条不能只看「两个 const 都存在」。
    const cn = ctorBlock('magicrewBalanceSelector')
    const intl = ctorBlock('magicrewIntlBalanceSelector')
    expect(cn).toContain('product: MAGICREW,')
    expect(intl).toContain('product: MAGICREW_INTL,')
    expect(cn).not.toContain('product: MAGICREW_INTL,')
    expect(intl).not.toContain('product: MAGICREW,')
  })

  /**
   * ⚠️ 上一条只读**源码文本**。这里驱动**真实** `BuddyBalanceSelector`：
   * 同一个 `fetchMagicrewBalance` 闭包、同一份凭据，只换 `product` ⇒ 请求必须打到
   * **各自的** host。若两站共用实例（或闭包写死站点），国际站那条会打到国内基址，
   * 而症状是「余额恒读不到 + 锁定时永远报无法确认」——**静默**、零报错。
   *
   * 2026-11-01 审查补：原先这里是一句 `expect(BuddyBalanceSelector).toBeTypeOf('function')`，
   * 实测把整个类换成一个「调用即抛」的桩后 **18 条全绿**（纯装饰）。
   */
  it('★★ 行为级：同一份余额读取，两个 `product` 打到各自的 host（串号会静默）', async () => {
    const makeSelector = (product: MagicrewProduct) => new BuddyBalanceSelector<
      MagicrewProduct,
      { jwt: string, organizationCode: string }
    >({
      product,
      resolveCredential: async () => ({ jwt: 'j.w.t', organizationCode: 'org' }),
      fetchBalance: async (credential, resolvedProduct) => {
        const balance = await fetchMagicrewBalance({
          jwt: credential.jwt,
          organizationCode: credential.organizationCode,
          product: resolvedProduct,
          fetchImpl: (async (input: unknown) => {
            seen.push(String(input))
            return jsonResponse(intlPointsResponse())
          }) as unknown as typeof fetch,
        })
        return balance ?? null
      },
    })
    const seen: string[] = []
    const candidates = [{ id: 'a', credentialRef: 'R1' }]
    await makeSelector(MAGICREW).select(candidates, { allowPermanent: true })
    await makeSelector(MAGICREW_INTL).select(candidates, { allowPermanent: true })

    expect(seen.length, '两个选号器都应发出一次余额请求').toBe(2)
    expect(seen[0], '国内站的余额请求必须打到国内 host').toContain(MAGICREW.host)
    expect(seen[1], '★ 国际站的余额请求必须打到国际 host（串号会静默读不到）')
      .toContain(MAGICREW_INTL.host)
    expect(seen[1], '★ 国际站不得打到国内 host').not.toContain(MAGICREW.host)
    // fixture 自检：两个 host 真的不同（相同则上面两条恒真）。
    expect(MAGICREW.host).not.toBe(MAGICREW_INTL.host)
  })
})
