/**
 * ★★★ **per-provider 窗口必须真的进入选号判据**（真实缺陷，2026-11-20）。
 *
 * ## 用户报障
 *
 * 「轮换起点为默认，积分列表都按预期排列了，临期积分在前（位次 2 在最前，
 *  因为它有临期积分），但是看 token 用量统计，实际用的还是位次 1」
 *
 * ## 缺陷本体
 *
 * per-provider 改造时只改了 `windowMs()`，**`imminentWindowMs()` 完全没改**：
 *
 * ```ts
 * // 错：只认 deps 覆盖，第二参 undefined 时回落全局 env/默认 5 天
 * return resolveImminentWindowMs(windowMs, this.deps.imminentWindowMs)
 * ```
 *
 * ⇒ 用户设「临期 30 / 短期 60」后，20 天后到期的积分：
 * - `windowMs()` 用新值（60 天）✅ ⇒ `expiring` 判对了
 * - `imminentWindowMs()` 仍是默认 5 天 ❌ ⇒ `imminent = 0` ⇒ tier 落到 `expiring`(1)
 *
 * ⇒ **临期段恒为空 ⇒ tier 永远到不了 0 ⇒ 选号永不优先烧临期积分**，
 *   而面板三档分色却按新窗口显示 —— 「面板说临期、选号当短期」。
 *
 * ## ⚠️ 为什么之前的测试没抓到
 *
 * 既有的 per-provider 测试（`credit-window.spec.ts` / `credit-window-live.spec.ts`）
 * 只断言 `resolveCreditWindow` 这个**纯函数**的返回值 —— 它一直是对的。
 * 缺陷在**消费侧**（selector 有没有把 `imminentDays` 用起来），
 * 那一层没有行为级用例。
 */
import { describe, expect, it } from 'vitest'
import { BuddyBalanceSelector } from '../../src/buddy-balance-selector.js'
import { rankBuddyAccountsByBalance } from '../../src/buddy-balance-rank.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 20, 2, 0, 0)

const pkg = (days, amount = 1000) => ({
  name: 'pkg', unit: 'credits',
  remaining: amount, total: amount, used: 0, active: true,
  cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  ...(days === undefined ? {} : { deductionEndTime: NOW + days * DAY }),
})

/** 建一个按 provider 返回窗口设置的 selector。 */
function makeSelector({ setting, balances, accounts }) {
  return new BuddyBalanceSelector({
    product: { id: 'buddy', endpoint: 'https://example.invalid' },
    resolveCredential: async (ref) => ({ ref }),
    fetchBalance: async (_credential, _product, ctx) => balances[ctx?.accountId] ?? null,
    now: () => NOW,
    readCreditWindow: (provider) => (provider === 'buddy' ? setting : undefined),
  })
}

/** 单号查询（省掉重复样板）。 */
async function classifyOne(setting, packages) {
  const selector = makeSelector({
    setting,
    balances: { a: { packages } },
    accounts: [{ id: 'a', credentialRef: 'r' }],
  })
  return selector.balanceOf({ id: 'a', credentialRef: 'r' })
}

describe('★★★ per-provider 窗口进入选号判据（真实缺陷）', () => {
  it('★★★ 设置比默认**宽**时，20 天后到期的积分必须判「临期」', async () => {
    // 设置 临期 30 / 短期 60；积分 20 天后到期
    const entry = await classifyOne({ windowDays: 60, imminentDays: 30 }, [pkg(20)])
    expect(entry.imminentBalance, '20 < 30 ⇒ 必须算临期（缺陷时是 0）').toBe(1000)
    expect(entry.tier, '临期档 = 0（缺陷时落到 expiring=1）').toBe(0)
  })

  it('★★★ 设置比默认**窄**时，3 天后到期的积分**不再**算临期', async () => {
    // 设置 临期 1 / 短期 2；积分 3 天后到期 ⇒ 已是永久（3 > 2）
    // 反例：按全局默认 5 天，3 天会算临期 ⇒ 提前烧掉不该烧的积分
    const entry = await classifyOne({ windowDays: 2, imminentDays: 1 }, [pkg(3)])
    expect(entry.imminentBalance, '3 > 1 ⇒ 不算临期').toBe(0)
    expect(entry.permanentBalance, '3 > 2 ⇒ 落到永久').toBe(1000)
  })

  it('★★★ 设置生效后，**实际选号**必须优先选临期号', async () => {
    // 账号池顺序：永久1 → 20天 → 永久2
    // 不按档位排会选第一个（永久1）；按档位排必须选 20 天那个
    const balances = {
      'p-1': { packages: [pkg(undefined, 5000)] },
      'd-20': { packages: [pkg(20, 1000)] },
      'p-2': { packages: [pkg(undefined, 5000)] },
    }
    const accounts = [
      { id: 'p-1', credentialRef: 'r1' },
      { id: 'd-20', credentialRef: 'r2' },
      { id: 'p-2', credentialRef: 'r3' },
    ]
    const selector = makeSelector({ setting: { windowDays: 60, imminentDays: 30 }, balances, accounts })
    const entries = []
    for (const account of accounts) entries.push(await selector.balanceOf(account))
    const ranked = rankBuddyAccountsByBalance(entries)
    expect(ranked[0].id, '必须选中 20 天后到期的号').toBe('d-20')
    expect(entries.find((e) => e.id === 'd-20')?.tier).toBe(0)
  })

  it('★ 无设置时行为与升级前一致（全局默认 15/5）', async () => {
    const setting = undefined
    // 20 天后到期 ⇒ 超过 15 天 ⇒ 永久
    expect((await classifyOne(setting, [pkg(20)])).permanentBalance).toBe(1000)
    // 10 天后到期 ⇒ 短期
    expect((await classifyOne(setting, [pkg(10)])).tier).toBe(1)
    // 3 天后到期 ⇒ 临期
    expect((await classifyOne(setting, [pkg(3)])).tier).toBe(0)
  })

  it('★★ `deps.imminentWindowMs` 显式覆盖仍然优先（逃生门没被破坏）', async () => {
    const selector = new BuddyBalanceSelector({
      product: { id: 'buddy', endpoint: 'https://example.invalid' },
      resolveCredential: async (ref) => ({ ref }),
      fetchBalance: async () => ({ packages: [pkg(20)] }),
      now: () => NOW,
      // 本渠道设置说 30 天临期，但显式覆盖成 1 天 ⇒ 覆盖优先
      readCreditWindow: () => ({ windowDays: 60, imminentDays: 30 }),
      imminentWindowMs: 1 * DAY,
    })
    const entry = await selector.balanceOf({ id: 'a', credentialRef: 'r' })
    expect(entry.imminentBalance, '显式覆盖 1 天 ⇒ 20 天不算临期').toBe(0)
  })

  it('⚠️ 临期窗口仍被钳制到 ≤ 短期窗口（不会倒挂）', async () => {
    // 设置里 imminentDays > windowDays（脏数据/手改 state.json）
    const entry = await classifyOne({ windowDays: 2, imminentDays: 99 }, [pkg(1.5)])
    // 1.5 < min(99, 2) = 2 ⇒ 仍算临期
    expect(entry.imminentBalance).toBe(1000)
    // 而 2.5 天后到期的不该算临期（> 2）
    const entry2 = await classifyOne({ windowDays: 2, imminentDays: 99 }, [pkg(2.5)])
    expect(entry2.imminentBalance).toBe(0)
  })

  /**
   * ★★★ **钳制必须真的发生在「临期窗口」这一层**（变异 M3 实测无牙后补）。
   *
   * ## 为什么上面那条挡不住 M3
   *
   * 上面用的是「积分 1.5 天 / 2.5 天」，而 `imminentDays = 99 天` ——
   * 即使**完全不钳制**，1.5 天仍 < 99 天（算临期）、2.5 天 < 99 天（也算临期）。
   * ⚠️ 等等：2.5 < 99 ⇒ 不钳制时**也算临期** ⇒ 上面第二条本该红……
   * 但它**没有红**，因为 `splitBuddyCreditsByExpiry` 内部还有一次
   * `imminent = min(imminentMs, windowMs)` 的兜底（与后端逐格同构）。
   *
   * ⇒ 想打中「selector 这一层有没有钳制」，必须让**两层钳制都被绕过**：
   *   看 `imminentBalance` 与 `expiringBalance` 的关系 —— 不变量是
   *   **`imminent <= expiring`**。selector 若把 `imminentMs` 传成 99 天而
   *   `windowMs` 只有 2 天，`split` 内部会兜住，故**这条腿本质上不可观测**
   *   （见下方说明），改为断言**可观测的**不变量。
   *
   * ## 结论：这一层的钳制是**冗余防御**，其效果被 split 内部钳制完全覆盖
   *
   * 如实登记：M3 无牙**是等价变异**（不是测试缺口）—— 两个实现产出逐字节相同。
   * 保留这行钳制的价值是「不依赖下游实现的防御」，但**不能为它编一个恒真用例**。
   * 这里改为钉住真正该成立的不变量。
   */
  it('★★ 不变量：临期恒 ≤ 短期窗口内（钳制链的最外层承诺）', async () => {
    for (const [days, expected] of [[0.5, true], [1.5, true], [2.5, false], [10, false]]) {
      const e = await classifyOne({ windowDays: 2, imminentDays: 99 }, [pkg(days)])
      expect(e.imminentBalance > 0, `${days} 天：临期判定`).toBe(expected)
      // 无论怎么钳，临期不能超过「短期窗口内」这个母量
      expect(e.imminentBalance, `${days} 天：imminent <= expiring`).toBeLessThanOrEqual(e.expiringBalance)
    }
  })

  /**
   * ★★★ **`deps.windowMs` 覆盖时，临期窗口必须跟着收窄**（变异 M3 有牙用例）。
   *
   * ## 为什么这条能咬住 M3（之前所有用例都咬不住）
   *
   * `resolveCreditWindow` 已把 `imminentDays` 钳到 ≤ **设置里的** `windowDays`。
   * 所以只要走设置这条腿，`imminentDays*DAY <= windowMs` 恒成立
   * ⇒ selector 里再调一次 `resolveImminentWindowMs` 是**恒等变换**（M3 无牙）。
   *
   * **唯一**能让两者分叉的输入是：`deps.windowMs` **覆盖得比设置的 windowDays 更窄**。
   * 此时 `imminentDays*DAY > windowMs`，而 `split` 内部**不做钳制**
   *（`buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry` 注释明写
   * 「由调用方经 resolveImminentWindowMs 归一」）⇒ 不钳制就会让临期窗口
   * 超出短期窗口，`imminent <= expiring` 的不变量被破坏。
   *
   * 实测（探针确认）：设置 30/60 + `deps.windowMs = 10 天`，一个 20 天后到期的号
   * - 钳制   ⇒ 临期窗口 10 天 ⇒ 20 > 10 ⇒ **不算临期**（permanent=1000）
   * - 不钳制 ⇒ 临期窗口 30 天 ⇒ 20 < 30 ⇒ **算临期**（imminent=1000）
   *
   * ⚠️ 这条同时钉住「`deps.windowMs` 与 per-provider 设置共存时的优先级」：
   *    `deps.windowMs` 是**总窗口**的硬覆盖，临期必须被它压住。
   */
  it('★★★ deps.windowMs 收窄时，临期窗口必须跟着收窄（不变量 imminent <= expiring）', async () => {
    const selector = new BuddyBalanceSelector({
      product: { id: 'buddy', endpoint: 'https://example.invalid' },
      resolveCredential: async (ref) => ({ ref }),
      fetchBalance: async () => ({ packages: [pkg(20)] }),
      now: () => NOW,
      readCreditWindow: () => ({ windowDays: 60, imminentDays: 30 }),
      // ⚠️ 总窗口被显式收窄到 10 天（比设置的 60 窄，也比临期设置的 30 窄）
      windowMs: 10 * DAY,
    })
    const entry = await selector.balanceOf({ id: 'a', credentialRef: 'r' })
    expect(entry.imminentBalance, '临期窗口必须被 windowMs 压到 10 天以内 ⇒ 20 天不算临期').toBe(0)
    expect(entry.expiringBalance, '20 > 10 ⇒ 也不在短期窗口内').toBe(0)
    // 不变量：临期不能超过短期母量
    expect(entry.imminentBalance).toBeLessThanOrEqual(entry.expiringBalance)
  })

  it('★ `0` 生效：临期设 0 ⇒ 没有任何号算临期', async () => {
    const entry = await classifyOne({ windowDays: 30, imminentDays: 0 }, [pkg(1)])
    expect(entry.imminentBalance, '临期 0 ⇒ 全部落短期').toBe(0)
    expect(entry.tier).toBe(1)
  })
})
