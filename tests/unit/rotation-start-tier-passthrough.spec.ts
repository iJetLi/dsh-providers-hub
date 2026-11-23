/**
 * ★★★ **跨层透传守卫**：`pickBuddyAccount` 必须把轮换起点的**四个**字段
 * 原样送到 `selector.select()`。
 *
 * ## 为什么需要这个文件（2026-11-23，真实缺陷）
 *
 * `rotationStartTier` 在 `pickBuddyAccount` 这一层**被静默丢弃**：
 *
 * - `credential-resolver.ts:656` 传了它；
 * - `index.ts` 也传了它；
 * - `buddy-balance-rank.ts:728` 在读它（`const tierAtSelection = options.rotationStartTier`）；
 * - **但中间的 `pickBuddyAccount` 的 options 类型里没有这个字段**，透传时也没带 ⇒
 *   最终 `rotateFromPreferred` 拿到的是 `undefined`。
 *
 * ## 为什么 tsc 全绿
 *
 * 调用方用的是**展开语法**：
 *
 * ```ts
 * ...(rotationStartTier === undefined ? {} : { rotationStartTier })
 * ```
 *
 * TS 的 excess-property 检查**只作用于直接的对象字面量**，展开的对象不受检
 * ⇒ 「传了一个类型上没有的字段」不报错、「中间层没声明」也不报错
 * ⇒ 整条链路无声断掉。
 *
 * ## 为什么既有测试全绿
 *
 * `tests/unit/rotation-s6.spec.ts` 是**直接调用** `rotateFromPreferred` 的
 *（L74 / L224 自造 options），绕过了 `pickBuddyAccount` 这一层
 * ⇒ 它证明的是「`rotateFromPreferred` 收到 tier 时行为正确」，
 * **证明不了**「`pickBuddyAccount` 真的把 tier 送过去了」。
 *
 * ⇒ 本文件的判据必须是**跨层**的：用替身 selector 截获 `select()` 的入参。
 *
 * ## 后果（缺陷的实际表现）
 *
 * `tierStillHeld = tierAtSelection !== undefined && tierNow === tierAtSelection`
 * 恒为 `false` ⇒ 永远走「起点已降档 ⇒ 交出首位」分支
 * ⇒ **「起点烧完临期后自动换人」这个机制从未生效**；
 * 实际行为退化成「起点不享受跨档优先，只做同档内的循环原点」。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  pickBuddyAccount,
  type BuddySelectionResult,
  type BuddySelectorLike,
} from '../../src/buddy-balance-selector.js'
import type { RotationStartTier } from '../../src/jet-hub-store.js'

/** 截获 `select()` 入参的替身选号器。 */
function captureSelector(
  result: BuddySelectionResult = { ok: false, reason: { kind: 'no-candidates' } },
): { selector: BuddySelectorLike; calls: unknown[] } {
  const calls: unknown[] = []
  const selector: BuddySelectorLike = {
    select: async (_candidates, options) => {
      calls.push(options)
      return result
    },
  }
  return { selector, calls }
}

const CANDIDATES = [{ id: 'acc-1', credentialRef: 'REF_1' }]

async function run(extra: Record<string, unknown>): Promise<unknown> {
  const { selector, calls } = captureSelector()
  await pickBuddyAccount(selector, CANDIDATES, {
    allowPermanent: true,
    resolveCredential: async () => ({ token: 'x' }),
    ...extra,
  })
  return calls[0]
}

describe('★★★ pickBuddyAccount 必须把轮换起点的四个字段送到 select()', () => {
  it('★★★ rotationStartTier 必须透传（真实缺陷）', async () => {
    const got = (await run({ rotationStartTier: 'imminent' })) as Record<string, unknown>
    expect(
      got.rotationStartTier,
      'rotationStartTier 在 pickBuddyAccount 这一层被丢弃 ⇒ rotateFromPreferred 永远拿 undefined '
      + '⇒ 「起点烧完临期后自动换人」从未生效',
    ).toBe('imminent')
  })

  it('★★★ 三档取值都要透传（不是只有某一档有效）', async () => {
    for (const tier of ['imminent', 'expiring', 'permanent'] as const) {
      const got = (await run({ rotationStartTier: tier })) as Record<string, unknown>
      expect(got.rotationStartTier, `档位 ${tier}`).toBe(tier)
    }
  })

  it('★★★ 四个字段同时在场时必须全部送到', async () => {
    const got = (await run({
      rotationStartId: 'acc-1',
      rotationStartTier: 'expiring',
      enabledAccountIds: ['acc-1'],
      strictManualOrder: true,
    })) as Record<string, unknown>
    expect(got).toMatchObject({
      rotationStartId: 'acc-1',
      rotationStartTier: 'expiring',
      enabledAccountIds: ['acc-1'],
      strictManualOrder: true,
    })
  })

  it('★★ 未传 rotationStartTier 时不出现在 select() 入参（不编造）', async () => {
    const got = (await run({ rotationStartId: 'acc-1' })) as Record<string, unknown>
    expect('rotationStartTier' in got).toBe(false)
  })

  /**
   * ⚠️ 这条是前一条的**反向对照**：证明判据不是恒真。
   *
   * 若某天有人把 `select()` 改成永远带 `rotationStartTier: undefined`，
   * 上一条会失败而这一条不会 —— 两条一起才能钉住「不传就不出现」。
   */
  it('★★ 反向对照：故意传 undefined 也不该留下该键', async () => {
    const got = (await run({ rotationStartTier: undefined })) as Record<string, unknown>
    expect('rotationStartTier' in got).toBe(false)
  })
})

describe('★★ 缺陷的可见后果（用真实选号函数验证）', () => {
  /**
   * ⚠️ 这条**不**断言「修好之后会怎样」，而是钉住缺陷的**行为形态**：
   * tier 丢失时 `rotateFromPreferred` 走「交出首位」分支。
   *
   * 它存在的意义：将来若有人「修」成别的东西（比如干脆删掉 S6），
   * 这条会告诉他原本的语义是什么。
   *
   * ⚠️ **数据形状必须用 `backendAccount` 那套**（直接给
   * `imminentBalance` / `expiringBalance` / `permanentBalance`），
   * 不能丢给 `rankBuddyAccountsByBalance` 去算 —— 它只重排、**不填档位字段**
   * ⇒ 我第一版那样造出的两个号都被判成 `none` 档，用例红得毫无意义
   *（2026-11-23 实测：`a-imm` 与 `a-start` 都得到 tier=3）。
   */
  it('★★ tier 缺失 ⇒ 起点交出首位（而不是绝对第一）', async () => {
    const { rotateFromPreferred, rankBuddyAccountsByBalance } = await import('../../src/buddy-balance-rank.js')

    /** 后端形状：直接给三个档位的余额（与 `rotation-s6.spec.ts` 同款）。 */
    const backendAccount = (
      id: string,
      imminent: number,
      shortTerm: number,
      permanent: number,
    ) => ({
      id,
      ok: true,
      imminentBalance: imminent,
      expiringBalance: imminent + shortTerm,
      permanentBalance: permanent,
      split: { expiring: imminent + shortTerm, permanent },
    })

    // a-start 是起点，它只有永久额度（3 个月后到期 ⇒ permanent 档）；
    // a-imm 有临期额度 ⇒ 比 a-start 更「优先」。
    const accounts = [
      backendAccount('a-imm', 100, 0, 0),
      backendAccount('a-start', 0, 0, 500),
    ]
    const ranked = rankBuddyAccountsByBalance(accounts)
    const pool = ['a-imm', 'a-start']

    // ① 带 tier（用户选定它时它是 permanent，现在仍是 permanent）⇒ 起点绝对第一
    const withTier = rotateFromPreferred(ranked, {
      rotationStartId: 'a-start',
      rotationStartTier: 'permanent' as RotationStartTier,
      enabledAccountIds: pool,
    })
    expect(withTier[0]?.id, '档位未变 ⇒ 起点绝对第一（S5）').toBe('a-start')

    // ② 不带 tier（= 缺陷时生产链路的实际情况）⇒ 交出首位，临期号前置
    const withoutTier = rotateFromPreferred(ranked, {
      rotationStartId: 'a-start',
      enabledAccountIds: pool,
    })
    expect(withoutTier[0]?.id, 'tier 缺失 ⇒ 起点失去跨档优先（缺陷形态）').toBe('a-imm')
  })

  /**
   * ★★★ **S6 的真正用处**：起点烧完临期后自动换人。
   *
   * 这条把「为什么需要 tier」讲清楚：
   * - 起点当初是 `imminent` 档（用户选它时它还有临期）；
   * - 临期烧完后它降到 `expiring`/`permanent` 档，但**仍然可用**；
   * - 没有 tier ⇒ 它继续占第一（S5 语义），继续烧自己的永久；
   * - 有 tier ⇒ 档位变了就交出首位。
   */
  it('★★★ S6 语义：起点降档后交出首位，未降档则保持第一', async () => {
    const { rotateFromPreferred, rankBuddyAccountsByBalance } = await import('../../src/buddy-balance-rank.js')
    const backendAccount = (
      id: string,
      imminent: number,
      shortTerm: number,
      permanent: number,
    ) => ({
      id,
      ok: true,
      imminentBalance: imminent,
      expiringBalance: imminent + shortTerm,
      permanentBalance: permanent,
      split: { expiring: imminent + shortTerm, permanent },
    })

    // 起点 a-start 的临期已烧光（只剩永久），池里 a-imm 还有临期。
    const accounts = [
      backendAccount('a-imm', 100, 0, 0),
      backendAccount('a-start', 0, 0, 500),
    ]
    const ranked = rankBuddyAccountsByBalance(accounts)
    const pool = ['a-imm', 'a-start']

    // 用户当初选 a-start 时它是 imminent 档 ⇒ 现在降到 permanent ⇒ 档位变了 ⇒ 交出首位
    const burned = rotateFromPreferred(ranked, {
      rotationStartId: 'a-start',
      rotationStartTier: 'imminent' as RotationStartTier,
      enabledAccountIds: pool,
    })
    expect(burned[0]?.id, '档位已变 ⇒ 交出首位，换还有临期的号').toBe('a-imm')
  })
})
