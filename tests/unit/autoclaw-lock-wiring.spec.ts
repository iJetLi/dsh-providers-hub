/**
 * AutoClaw（国内站 `autoclaw` / 国际版 `autoclawintl`）的
 * 「锁定永久积分」**接线**回归。
 *
 * ## 为什么单独守这个
 *
 * 2026-10-21 合并审计发现本家**确实有永久桶**，但 `permanentLock` 未登记
 * ⇒「锁定永久积分」按钮**不渲染**、`credits.permanentLock` RPC 直接
 * `bad-request` ⇒ 用户**无法**保护那笔永不作废的积分（**功能缺失**，不是缺陷）。
 * 用户随后明确要求「补锁定开关」，本文件守的就是这次补齐。
 *
 * ## 本家的两个特异点（照抄别家会错）
 *
 * 1. **永久桶真的存在**：`autoclaw-credits.ts` 的批次映射写着
 *    「**无到期字段的发放**（活动赠送的永久分）⇒ 不带 `deductionEndTime`（= 永久桶）」。
 * 2. **`rateLimit: false` + 刻意不做请求级换号**：本家的锁定只作用于
 *    「按余额分档选号」这一层，不涉及换号冷却（本来就没有）。
 *    ⚠️ 这也意味着**不能照抄 buddy 系那两行的取舍**。
 *
 * ## 判据分三层（由弱到强）
 *
 * 1. **registry 契约**：两站都 `permanentLock === true`（且 `usesExpiryWindow` 已在前）。
 * 2. **源码接线**：`index.ts` 里确实建了两个选号器、各自接到工厂的 `balance.selector`、
 *    各自传了带**本站 `displayName`** 的 `lockedError`、两站都 `reportPickedAccount: true`。
 *    ⚠️ 每条都按**该站的接线区间**切片，不用全局正则（全局正则会命中别人家 ——
 *    本仓库已实测两次无牙）。
 * 3. **分档行为**：把**真实上游报文形状**（钱包 + 流水批次，`wallet_expires_at`
 *    是**秒**级）喂给生产解析器 `parseAutoclawLedgerBatches`，再用
 *    `splitBuddyCreditsByExpiry` / `buddyBalanceTier` 验证「锁定后只剩永久积分
 *    ⇒ 该号不可用」。这一层驱动生产判据，不是复述实现。
 *
 * ⚠️ **不做**的事：不发真实网络（`fetcher` 全部注入假实现）、不读真实凭据。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'
import { parseAutoclawLedgerBatches } from '../../src/autoclaw-credits.js'
import { fetchAutoclawBalanceDetailed } from '../../src/autoclaw-credits.js'
// ⚠️ 2026-10-21 二轮审计：验证「流水降级不得谎报积分用尽」需要真跑选号器
import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import {
  BUDDY_BALANCE_TIER,
  BUDDY_EXPIRING_WINDOW_DAYS,
  buddyBalanceTier,
  buddyTierUsable,
  splitBuddyCreditsByExpiry,
} from '../../src/buddy-balance-rank.js'
import { AUTOCLAW, AUTOCLAW_INTL } from '../../src/autoclaw-product.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 接线断言不能因为「注释里提到了某个符号」就通过：本仓库注释大量解释
 * 「为什么不能走某条兜底」，对兜底的**否定**断言必须只看代码
 * （与 `minimax-lock-wiring.spec.ts` 的 `codeOnly` 同一约定）。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
const indexCode = codeOnly(indexSource)

/**
 * 取某个选号器的接线区间（`selector: <name>,` 起，到下一站的 selector /
 * 下一个同级 `const` / 适配器注册为止）。
 *
 * ⚠️ **必须切片**：`src/index.ts` 里 `throwIfAllRateLimited` 有 16 处、
 * `reportPickedAccount: true` 有多处 ⇒ 全局正则恒真（本仓库实测过两次）。
 * ⚠️ **不能取裸 `'},'`**：`fallback: { kind: 'ref', … }` 里也有 `},`，
 * 而本家那两个字段恰好在 `fallback` **之后** ⇒ 会切成空区间。
 */
function selectorBlock(name: string): string {
  const at = indexCode.indexOf(`selector: ${name},`)
  expect(at, `找不到 selector: ${name},`).toBeGreaterThan(-1)
  const candidates = [
    indexCode.indexOf('selector: autoclawBalanceSelector,', at + 1),
    indexCode.indexOf('selector: autoclawIntlBalanceSelector,', at + 1),
    indexCode.indexOf('\n  const ', at + 1),
    indexCode.indexOf('registerAutoclawLlm(', at + 1),
  ].filter((i) => i > at)
  const block = indexCode.slice(at, candidates.length > 0 ? Math.min(...candidates) : undefined)
  expect(block.length, `${name} 的接线区间切成了空——判据会变成同义反复`).toBeGreaterThan(50)
  return block
}

/**
 * 真实 `/agent-assetmgr/api/v1/ledgers_std` 的条目形状（2026-10 实测）。
 *
 * ⚠️ `wallet_expires_at` 是**秒**级 unix 时间戳（不是毫秒）—— 生产解析器
 * 乘 1000 归一成 `deductionEndTime`（与 buddy / officeace 同单位）。
 * ⚠️ **不带该字段的发放 = 永久分**（本家永久桶的唯一来源，见 §「为什么需要本文件」）。
 */
interface LedgerEntryLike {
  mutation_type: 'credit' | 'debit' | 'expire'
  amount: number
  wallet_expires_at?: number
  description: string
}

const NOW_MS = Date.now()
const DAY_S = 86400
const NOW_S = Math.floor(NOW_MS / 1000)

describe('★ AutoClaw：`permanentLock` 的 registry 契约', () => {
  it('两站都登记了 permanentLock', () => {
    for (const id of ['autoclaw', 'autoclawintl']) {
      // 缺它 ⇒ 客户端 `supportsPermanentLock()` 为 false ⇒ 按钮**不渲染**，
      // 且 `credits.permanentLock` RPC 直接 `bad-request`。
      expect(descriptorOf(id)?.permanentLock, `${id} 应支持锁定永久积分`).toBe(true)
    }
  })

  it('后端白名单（PERMANENT_LOCK_PROVIDERS）由 registry 派生且含两站', () => {
    // 直接钉住「派生关系」，而不是只断言成员 —— 有人手抄一份名单会在这里红。
    const derived = PROVIDER_REGISTRY.filter((d) => d.permanentLock === true).map((d) => d.id).sort()
    expect(derived).toContain('autoclaw')
    expect(derived).toContain('autoclawintl')
    expect([...PERMANENT_LOCK_PROVIDERS].sort()).toEqual(derived)
  })

  it('⚠️ 两站是**两个**渠道 id（共用一个 AutoclawAuth 不等于共用一个 id）', () => {
    expect(AUTOCLAW.id).toBe('autoclaw')
    expect(AUTOCLAW_INTL.id).toBe('autoclawintl')
    expect(AUTOCLAW.id).not.toBe(AUTOCLAW_INTL.id)
  })
})

describe('★ AutoClaw：`index.ts` 的接线（源码级，按渠道切片）', () => {
  it('两站各建一个选号器，且各自接到工厂的 balance.selector', () => {
    expect(indexCode).toMatch(
      /const autoclawBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: AUTOCLAW,/,
    )
    expect(indexCode).toMatch(
      /const autoclawIntlBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: AUTOCLAW_INTL,/,
    )
    // 建了不用 = 死代码，锁定仍无执行路径。
    expect(selectorBlock('autoclawBalanceSelector'), '中国版的 balance.selector 必须指向 autoclawBalanceSelector')
      .toContain('lockedError: autoclawLockedError(\'AutoClaw\'),')
    expect(selectorBlock('autoclawIntlBalanceSelector'), '国际版的 balance.selector 必须指向 autoclawIntlBalanceSelector')
      .toContain('lockedError: autoclawLockedError(\'AutoClaw (国际版)\'),')
  })

  it('★★ 两站都必须 reportPickedAccount: true（账本归属不能因新增 balance 而丢）', () => {
    // ⚠️ 本家的旧闭包是**纯池选号**、账本**一直在回报** ⇒ 接上 `balance` 后
    //    「分档选中」那一支若不回报，token 用量记不到本渠道（静默）。
    //    ⚠️ 逐站切片 —— 全局计数的形态本仓库已实测无牙两次。
    for (const [name, display] of [
      ['autoclawBalanceSelector', "autoclawLockedError('AutoClaw')"],
      ['autoclawIntlBalanceSelector', "autoclawLockedError('AutoClaw (国际版)')"],
    ] as const) {
      const block = selectorBlock(name)
      expect(block, `${name} 的区间必须含 lockedError: ${display}`).toContain(`lockedError: ${display}`)
      expect(block, `${name} 必须 reportPickedAccount: true（否则账本归属丢失）`)
        .toMatch(/reportPickedAccount:\s*true,/)
      expect(block, `${name} 不得写 reportPickedAccount: false`)
        .not.toMatch(/reportPickedAccount:\s*false/)
    }
  })

  it('★ 两站都接限流判定（池被筛空时会误报「请先登录」）', () => {
    for (const name of ['autoclawBalanceSelector', 'autoclawIntlBalanceSelector']) {
      expect(
        selectorBlock(name),
        `${name} 必须接 throwIfAllRateLimited（Gitee IKJOZ9 的形态）`,
      ).toMatch(/throwIfAllRateLimited:\s*throwIfAllAccountsRateLimited/)
    }
  })

  it('★★ 两站的 fetchBalance 闭包必须透传 product 形参（不得写死对方站点）', () => {
    // `BuddyBalanceSelector.select` 调的是 `injected(credential, this.deps.product)`
    // ⇒ 闭包里忽略形参、写死站点常量就会打到**对方站点**（余额恒 null，静默）。
    // ⚠️ 本家的 `fetchAutoclawCreditBalance` 第二参是 `{ product }`（对象），
    //    与 qoder 那份的 `(credential, product)` 位置顺序**不同**。
    const cases = [
      ['autoclawBalanceSelector', 'AUTOCLAW_INTL'],
      ['autoclawIntlBalanceSelector', 'AUTOCLAW,'],
    ] as const
    for (const [name, other] of cases) {
      const block = selectorBlock(name)
      // 闭包可能在 selector 之后（在 balance 块里）—— 两个位置都接受，
      // 但要求**恰有一处**且引用 product 形参。
      const ctor = indexCode.slice(
        indexCode.indexOf(`const ${name} = new BuddyBalanceSelector({`),
        indexCode.indexOf('\n  const ', indexCode.indexOf(`const ${name} = new BuddyBalanceSelector({`) + 10),
      )
      const line = ctor.match(/fetchBalance:[^\n]*/)
      expect(line, `${name} 的构造函数里必须注入 fetchBalance`).not.toBeNull()
      expect(line![0], `${name} 必须把 product 形参传给 fetchAutoclawCreditBalance`)
        .toMatch(/\(credential, product\)\s*=>\s*fetchAutoclawCreditBalance\(credential, \{ product \}\)/)
      expect(line![0], `★ ${name} 的 fetchBalance 不得写死 ${other}（会打到对方站点，余额恒 null）`)
        .not.toContain(other)
      expect(block.length).toBeGreaterThan(50)
    }
  })

  it('⚠️ 两站的 readCredential 共用同一份解析器（不得各写一份逐字重复的内联实现）', () => {
    // 本次顺带把两份逐字重复的内联 `JSON.parse` 抽成了 `resolveAutoclawCredentialByRef`。
    // 判据：`readCredential: resolveAutoclawCredentialByRef` 出现**恰好两次**
    //（两站各一），且内联的 `JSON.parse(...) as unknown as AutoclawCredential`
    //  全局只剩**一处**（共用解析器自己那份）。
    //
    // ⚠️ **第一版把这条写成「不得出现」⇒ 恒红**：共用解析器自己就含那一行。
    //    正确的判据是**计数恰好为 1**，不是「零出现」——
    //    这是「否定断言写过头」的典型形态（与把 `toBe(false)` 写成 `not.toContain`
    //    时需要先确认目标真的不在同一个文件里，是同一类错误）。
    const uses = indexCode.match(/readCredential:\s*resolveAutoclawCredentialByRef,/g) ?? []
    expect(uses.length, '两站都应改用共用解析器').toBe(2)
    const inline = indexCode.match(/JSON\.parse\(resolved\.value\) as unknown as AutoclawCredential/g) ?? []
    expect(
      inline.length,
      '内联实现应只留在共用解析器里那一份（若为 3 处 = 两站各一份 + 共用那份 ⇒ 没抽干净）',
    ).toBe(1)
  })
})

describe('★★ AutoClaw：分档行为（驱动生产判据，不复述实现）', () => {
  /**
   * 本家的**永久桶**来自「无 `wallet_expires_at` 的发放」——
   * 这正是「需要锁定能力」的全部理由，故行为层必须先证明它真的产出永久桶。
   */
  it('★ 无到期字段的发放 ⇒ 落永久桶（本家需要锁定的根本原因）', () => {
    const batches = parseAutoclawLedgerBatches([
      { mutation_type: 'credit', amount: 5000, description: '活动赠送' },
    ], NOW_MS)
    expect(batches, '应产出一个包').toHaveLength(1)
    expect(
      batches[0]!.deductionEndTime,
      '无 wallet_expires_at ⇒ 不带 deductionEndTime（= 永久桶）',
    ).toBeUndefined()
    const split = splitBuddyCreditsByExpiry({ packages: batches }, NOW_MS)
    expect(split, '永久桶应被识别').toEqual({ expiring: 0, permanent: 5000 })
  })

  it('★★ 锁定后只剩永久积分 ⇒ 该账号不可用（锁定真的会拦）', () => {
    const batches = parseAutoclawLedgerBatches([
      { mutation_type: 'credit', amount: 5000, description: '活动赠送' },
    ], NOW_MS)
    const split = splitBuddyCreditsByExpiry({ packages: batches }, NOW_MS)
    const entry = { id: 'a', expiringBalance: split!.expiring, permanentBalance: split!.permanent }
    const windowMs = BUDDY_EXPIRING_WINDOW_DAYS * 86400_000
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

  it('★ 有临期批次时锁定仍可用（锁定只挡永久桶，不挡临期桶）', () => {
    // 10 天后到期的发放批次（**秒**级）⇒ 落在 15 天窗口内 ⇒ 临期桶。
    const batches = parseAutoclawLedgerBatches([
      { mutation_type: 'credit', amount: 300, wallet_expires_at: NOW_S + 10 * DAY_S, description: '每日签到' },
      { mutation_type: 'credit', amount: 5000, description: '活动赠送' },
    ], NOW_MS)
    const split = splitBuddyCreditsByExpiry({ packages: batches }, NOW_MS)
    expect(split!.expiring, '10 天后的批次应进临期桶').toBe(300)
    expect(split!.permanent, '无到期字段的应进永久桶').toBe(5000)
    const entry = { id: 'a', expiringBalance: split!.expiring, permanentBalance: split!.permanent }
    expect(
      buddyBalanceTier(entry, { allowPermanent: false, windowMs: BUDDY_EXPIRING_WINDOW_DAYS * 86400_000 }),
      '锁定状态下有临期额度 ⇒ 仍可用',
    ).toBe(BUDDY_BALANCE_TIER.expiring)
  })

  it('★ 消耗（debit）后永久桶按净额，不是按历史发放额', () => {
    // ⚠️ 这是本仓库「流水 amount 是历史发放额」那条 P0 的形态：
    //    直接拿 credit 求和会把已消耗的算成可用。
    const batches = parseAutoclawLedgerBatches([
      { mutation_type: 'credit', amount: 5000, description: '活动赠送' },
      { mutation_type: 'debit', amount: -1200, description: '活动赠送' },
    ], NOW_MS)
    const split = splitBuddyCreditsByExpiry({ packages: batches }, NOW_MS)
    expect(split!.permanent, '净额 = 5000 - 1200').toBe(3800)
  })

  it('⚠️ 已过期的批次被丢弃（不进任何桶）', () => {
    const batches = parseAutoclawLedgerBatches([
      { mutation_type: 'credit', amount: 800, wallet_expires_at: NOW_S - 5 * DAY_S, description: '过期批次' },
      { mutation_type: 'credit', amount: 999, wallet_expires_at: NOW_S + 10 * DAY_S, description: '有效批次' },
    ], NOW_MS)
    expect(batches, '只应剩有效批次').toHaveLength(1)
    expect(batches[0]!.name).toContain('有效批次')
  })
})

/**
 * ★★ **流水降级时不得谎报「积分都已用尽」**（2026-10-21 二轮审计发现，P1）。
 *
 * ## 缺陷（已复现，真实可达）
 *
 * 本家余额有**两条数据源**：钱包端点（必成，给总额）+ 流水端点（给逐批次到期）。
 * 流水失败 / 守恒不成立时 `fetchAutoclawBalanceDetailed` **静默回退钱包包** ——
 * 总额对，但**逐包到期全部丢失**（钱包包没有 `deductionEndTime`）。
 *
 * 而 `splitBuddyCreditsByExpiry` 把「没有到期时刻」判成**永久桶**（对真·永久是对的）
 * ⇒ 一次流水抖动会让「有临期积分的账号」被判成**只剩永久积分** ⇒
 * 锁定状态下报「积分都已用尽」—— **那句会把用户推向不可撤回的解锁**
 *（`credential-resolver.ts` 的注释原话：「会把用户推向解锁永久积分（不可撤回地烧钱）」）。
 *
 * 实测（同一账号、同一 5000 余额，**只改流水端点是否 500**）：
 * ```
 * 流水正常 → split={expiring:5000} tier=expiring  select=ok        ✅
 * 流水 500 → split={permanent:5000} tier=none      select=exhausted ❌（修前）
 * 流水 500 → degraded=true                          select=unknown   ✅（修后）
 * ```
 *
 * ## 修法
 *
 * `CreditBalance.degraded`（可选）——「总额读到了、明细丢了」；
 * `BuddyBalanceSelector` 把它透传到 `BuddyAccountBalanceEntry.degraded`，
 * `noAccountReason` 把降级**与失败同等对待**（归 `unknown`，不归 `exhausted`）。
 */
describe('★★ AutoClaw：流水降级不得谎报「积分都已用尽」', () => {
  const NOW = Date.now()
  const DAY = 86400_000

  function walletAndLedger(ledgerFails: boolean) {
    return async (url: string | URL): Promise<Response> => {
      const u = String(url)
      if (u.includes('/wallets')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            total_balance: 5000,
            wallets: [{
              public_wallet_type: 'reward', display_name: '奖励积分',
              balance: 5000, display: true, priority: 10,
            }],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('ledgers')) {
        if (ledgerFails) return new Response('boom', { status: 500 })
        const exp = Math.floor((NOW + 5 * DAY) / 1000)
        return new Response(JSON.stringify({
          code: 0,
          data: { entries: [
            { mutation_type: 'credit', amount: 5000, wallet_expires_at: exp, description: '每日签到' },
          ] },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }
  }

  function selectorWith(ledgerFails: boolean) {
    return new BuddyBalanceSelector({
      product: { id: 'autoclaw', endpoint: 'https://x.invalid' } as never,
      resolveCredential: async () => ({ access_token: 't'.repeat(40) }) as never,
      fetchBalance: async (cred) =>
        (await fetchAutoclawBalanceDetailed(cred as never, {
          fetcher: walletAndLedger(ledgerFails) as never,
        })).balance,
    })
  }

  const candidate = [{ id: 'a1', credentialRef: 'AUTOCLAW_ACCOUNT_A1' }]

  it('★ 流水正常 ⇒ 不标 degraded，且锁定下只有临期额度时**可用**（反向对照）', async () => {
    const s = selectorWith(false)
    const b = await s.balanceOf(candidate[0]! as never)
    expect(b.degraded, '正常路径不得带 degraded 标记').toBeUndefined()
    expect(b.expiringBalance, '5 天后到期 ⇒ 临期桶').toBe(5000)
    const sel = await s.select(candidate as never, { allowPermanent: false })
    expect(sel.ok, '★ 有临期额度 ⇒ 锁定下仍应可用（否则本组判据在测别的东西）').toBe(true)
  })

  it('★★ 流水 500 ⇒ 标 degraded，且锁定下报 unknown（**不是** exhausted）', async () => {
    const s = selectorWith(true)
    const b = await s.balanceOf(candidate[0]! as never)
    expect(
      b.degraded,
      '★ 流水回退必须打 degraded 标记（否则「读不到明细」会被当成「只剩永久积分」）',
    ).toBe(true)
    // 修前这里会是 permanent=5000 ⇒ tier=none ⇒ exhausted。
    expect(b.permanentBalance, '回退包的到期信息丢失 ⇒ 被算进永久桶（这是既有行为）').toBe(5000)
    const sel = await s.select(candidate as never, { allowPermanent: false })
    expect(sel.ok).toBe(false)
    if (sel.ok) return
    expect(
      sel.reason.kind,
      '★ 必须报 unknown（「无法确认」）—— 报 exhausted 会把用户推向不可撤回的解锁',
    ).toBe('unknown')
    expect(sel.reason.kind === 'unknown' && sel.reason.errors.join('')).toContain('逐包明细')
  })
})

/**
 * ★★ **文案不得点名未经实测的池名**（2026-10-21 二轮审计，P1 文案失实）。
 *
 * ## 缺陷
 *
 * `autoclawLockedError` 初版写「**永久桶**（**「活动赠送」「注册奖励」** 等
 * 不带到期时间的批次）」。审计员逐层考古确认这两个名字**没有任何实测来源**：
 *
 * - 包名实际取 `metadata.description > description > source`，即**上游给什么就是什么**；
 * - 仓库内唯一实测样本是「`AutoClaw 用户登录奖励积分，7天有效`」「`每日签到`」；
 * - 「活动赠送 / 注册奖励」最早出自 `autoclaw-credits.ts` 里一句**描述代码分支**的
 *   注释，经 registry → 审计报告 → 提交信息 → 文案 **五层转述**，零次报文支撑。
 *
 * ## 用户可见后果
 *
 * 用户照着去钱包流水里找叫「活动赠送」「注册奖励」的分组 ⇒ **一无所获**。
 *
 * ## 判据
 *
 * 文案（`LlmError` 的 message）里**不得出现**这些未实测的池名；注释里作为
 * **反面例子**引用是可以的（所以本用例只查 message 拼接段，不查整个函数）。
 */
describe('★★ AutoClaw：锁定文案不得点名未实测的池名', () => {
  it('exhausted 档的 message 拼接段里不得出现「活动赠送」「注册奖励」', () => {
    const start = indexCode.indexOf("const autoclawLockedError")
    expect(start, '找不到 autoclawLockedError').toBeGreaterThan(-1)
    // ⚠️ 终点必须用「下一个同级声明」，**不能**用 `/**`：
    //    `indexCode` 是 `codeOnly()` 剥过注释的文本，`'/**'` 在里面**根本不存在**
    //    ⇒ `indexOf` 返回 `-1` ⇒ `slice(start, -1)` 一直切到**文件末尾**。
    //    此前恰好只有 autoclaw 这一家在用 `'QUOTA_EXCEEDED'`，所以「四档」碰巧成立；
    //    2026-11-01 加上 magicrew（四档同样是 `QUOTA_EXCEEDED`，写在它**之后**）
    //    才让这条抓出 8 段。修成 `'\n  const '` 后切片真的止于本构造器。
    const end = indexCode.indexOf('\n  const ', start + 10)
    const block = indexCode.slice(start, end > start ? end : indexCode.length)
    // 只取 `new LlmError(` 之后、`'QUOTA_EXCEEDED'` 之前的**文案拼接段**。
    const messages = [...block.matchAll(/new LlmError\(([\s\S]*?)'QUOTA_EXCEEDED'/g)].map((m) => m[1]!)
    expect(messages.length, '应找到四档文案').toBe(4)
    for (const msg of messages) {
      for (const bogus of ['活动赠送', '注册奖励']) {
        expect(
          msg.includes(bogus),
          `★ 文案不得点名「${bogus}」—— 该池名无任何实测来源，用户会照着去找、一无所获`
          + '（真实包名是上游原样字符串，如「AutoClaw 用户登录奖励积分，7天有效」）',
        ).toBe(false)
      }
    }
    // 自检：拼接段确实非空（否则上面是恒真）。
    expect(messages.join('').length).toBeGreaterThan(200)
  })
})

/**
 * ★ **降级结果必须走短 TTL**（2026-10-21 二轮审计，P2）。
 *
 * ## 缺陷
 *
 * `ok: true` + `degraded: true` 的语义是「总额读到了、明细丢了」—— 它是
 * 一次**瞬态不确定性**（流水端点抖动），不是稳定的成功读数。
 * 若按 `ok` 走 60 秒长 TTL ⇒ 一次抖动 ⇒ **60 秒内每次选号都报 `unknown`**。
 *
 * 修法：降级与失败同等对待，走 `errorTtlMs`（默认 5 秒）⇒ 抖动一过即自愈。
 *
 * ⚠️ 判据读的是 `cached.source.balance.degraded`（**原料**）而不是 classify
 * 之后的条目 —— 因为这段代码在决定「要不要重算」。
 */
describe('★ AutoClaw：降级结果的缓存 TTL 必须与错误同档（短）', () => {
  it('流水失败后 5 秒内复用、超过 5 秒重查（不按 60 秒长 TTL 缓存）', async () => {
    let ledgerCalls = 0
    let nowMs = 1_700_000_000_000
    const selector = new BuddyBalanceSelector({
      product: { id: 'autoclaw', endpoint: 'https://x.invalid' } as never,
      resolveCredential: async () => ({ access_token: 't'.repeat(40) }) as never,
      now: () => nowMs,
      fetchBalance: async (cred) => {
        ledgerCalls += 1
        const detail = await fetchAutoclawBalanceDetailed(cred as never, {
          fetcher: (async (url: string | URL) => {
            const u = String(url)
            if (u.includes('/wallets')) {
              return new Response(JSON.stringify({
                code: 0,
                data: {
                  total_balance: 500,
                  wallets: [{
                    public_wallet_type: 'reward', display_name: '奖励积分',
                    balance: 500, display: true, priority: 10,
                  }],
                },
              }), { status: 200, headers: { 'content-type': 'application/json' } })
            }
            // 流水恒 500 ⇒ 恒降级
            return new Response('boom', { status: 500 })
          }) as never,
        })
        return detail.balance
      },
    })
    const cand = [{ id: 'a1', credentialRef: 'AUTOCLAW_ACCOUNT_A1' }]

    const first = await selector.balanceOf(cand[0]! as never)
    expect(first.degraded, '流水 500 ⇒ 应降级').toBe(true)
    expect(ledgerCalls).toBe(1)

    // 4 秒后：仍在短 TTL 内 ⇒ 复用缓存（不重查）。
    nowMs += 4_000
    const second = await selector.balanceOf(cand[0]! as never)
    expect(second.degraded).toBe(true)
    expect(ledgerCalls, '4 秒内应复用缓存').toBe(1)

    // 再 +2 秒（累计 6 秒 > 5 秒短 TTL）：应重查 —— 若按 60 秒长 TTL 则这里仍是 1。
    nowMs += 2_000
    await selector.balanceOf(cand[0]! as never)
    expect(
      ledgerCalls,
      '★ 降级不得按 60 秒长 TTL 缓存 —— 否则一次流水抖动会让选号在 60 秒内持续报 unknown',
    ).toBe(2)
  })
})

/**
 * ★★ **AutoClaw 401 按需续期** 的守卫已**迁出本文件**。
 *
 * ## 为什么搬走（2026-10-27 两轮审计的共同结论）
 *
 * 原先这里是四条**源码文本断言**（`toMatch(/refresh:\s*async\s*\(\)\s*=>/)`
 * + `toContain('…refreshAccountCredential(')` + 一条 `not.toMatch` 反向断言）。
 * 红队逐字复刻判据后实测，以下五种**假接线全部绿**：
 *
 * | 假接线 | 为什么骗过文本断言 |
 * |---|---|
 * | 片段塞进**字符串字面量** | `toContain` 只找子串 |
 * | **行尾** `//` 冒充（`codeOnly` 只剥整行 `//`） | 剥注释不覆盖行尾 |
 * | `if (false) { …真接线… }` | 字面量在死分支里照样存在 |
 * | `if (Math.random() >= 0) return` 恒早退 | 真实现变 no-op，文本一字不少 |
 * | 整块塞进 `false ? … : async () => {}` | 同上 |
 *
 * 反向还有**假红**：`refresh: () => autoclaw.refresh()` 这类合法重构会红
 * —— 判据钉的是**字面写法**而不是行为。
 *
 * ⇒ 改为 **行为级** 守卫：`tests/unit/autoclaw-401-refresh-wiring.spec.ts`
 *   真跑 `apply()`、真驱动适配器、让第一次请求 401，断言
 *   「被续期的是**本次实际用的那个账号**」且「重发用的是**新** token」。
 *
 * 变异验证（6 个，全部逐条跑过，见该文件的模块头）：
 * 忽略 `used` / 不返回新凭据 / 删键 / 不传 `entry.id` / 空实现 / 国际版忽略 `used`
 * ⇒ **全部变红**（其中「忽略 used」「空实现」「国际版忽略 used」在旧的文本守卫下
 * 是**绿的**，即本文件原先那组确实无牙）。
 *
 * ⚠️ 本文件保留的**其它**组（永久积分锁定、选号器接线、分档行为）判据形态不变 ——
 * 它们守的是「接线点在不在」这一较弱的不变式，且已有行为层用例兜底。
 */
